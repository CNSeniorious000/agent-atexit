import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { ActionStore, resolveStateRoot, type RunRecord, type SessionBinding } from "../../../packages/core/src/index.ts";

export const name = "atexit";
export const inject = ["tools"];
export interface Config { ask?: boolean }
export const Config = z.object({ ask: z.boolean().default(false).description("Ask for host approval before registering each deferred command.") });

interface WorkspaceDomainChange {
  domain?: unknown;
  operation?: unknown;
  table?: unknown;
  value?: unknown;
}

interface WorkspaceDomainEvents {
  on(name: "domain/changed", listener: (change: WorkspaceDomainChange) => void, options: { global: true }): () => boolean;
}

function archivedSessionIds(change: WorkspaceDomainChange): string[] {
  if (change.domain !== "workspace" || change.table !== "" || change.operation !== "put" || typeof change.value !== "object" || change.value === null) return [];
  const ids = (change.value as { archivedSessionIds?: unknown }).archivedSessionIds;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
}

export function apply(ctx: Context, config: Config = {}): void {
  const root = resolveStateRoot();
  const store = new ActionStore(root);
  const agents = new WeakMap<Agent, SessionBinding>();
  const sessions = new Map<string, SessionBinding>();

  const startRun = (run: RunRecord): void => {
    const worker = fileURLToPath(new URL("./worker.js", import.meta.url));
    const child = spawn("node", [worker, "--state-dir", root, "--run-id", run.id], { detached: true, env: { ...process.env, AGENT_ATEXIT_STATE_DIR: root }, stdio: "ignore" });
    child.unref();
  };
  const closeSession = async (binding: SessionBinding): Promise<void> => {
    const run = await store.closeAndClaim(binding);
    if (run) startRun(run);
  };
  const closeFromEvent = (binding: SessionBinding): void => {
    void closeSession(binding).catch((error) => ctx.logger.warn(`agent-atexit: failed to close session ${binding.sessionId}: ${String(error)}`));
  };
  const bindingFor = (agent: Agent): SessionBinding => {
    const existing = agents.get(agent);
    if (existing) return existing;
    const binding = { cwd: agent.session.header.cwd ?? process.cwd(), host: "dsh", sessionId: String(agent.session.id) };
    agents.set(agent, binding);
    sessions.set(binding.sessionId, binding);
    agent.ctx.effect(() => () => closeSession(binding), "agent-atexit: session cleanup");
    return binding;
  };

  ctx.on("session/disposed", (session) => {
    const id = String(session.id);
    const binding = sessions.get(id);
    if (binding) closeFromEvent(binding);
    sessions.delete(id);
  }, { global: true });
  // dsh archive is a durable visibility change, not Agent disposal. Bridge its workspace-domain signal so archived sessions still drain.
  (ctx as unknown as WorkspaceDomainEvents).on("domain/changed", (change) => {
    for (const id of archivedSessionIds(change)) {
      const binding = sessions.get(id);
      if (binding) closeFromEvent(binding);
      sessions.delete(id);
    }
  }, { global: true });
  ctx.on("tools/pre-execute", (exec, next) => config.ask && exec.name === "atexit_register" ? Promise.resolve({ kind: "ask", reason: "Authorize this exact argv command to execute later when the current agent session exits." }) : next(), { global: true });
  ctx.tools.register(defineTool({
    name: "atexit_register",
    description: "Before starting any CLI-managed session or long-lived process that could outlive this agent session—such as a browser session, daemon, or dev server—register its exact cleanup argv. Registration is deferred, so keep it while the resource remains available for follow-up. If creation assigns the cleanup target, register immediately afterward. Cancel only after normal cleanup. argv executes directly, without a shell.",
    parameters: {
      argv: { type: "array", required: true, items: { type: "string" }, description: "Executable followed by literal arguments." },
      cwd: { type: "string", description: "Absolute working directory. Defaults to the session cwd." },
      key: { type: "string", description: "Optional replacement key." },
      timeout_ms: { type: "integer", description: "Command timeout in milliseconds. Defaults to 30000." },
    },
    output: {
      schema: { type: "object", additionalProperties: false, properties: { registration_id: { type: "string", required: true }, state: { type: "string", required: true } } },
      render: (_args, value) => [{ type: "text", text: `Registered ${String((value as { registration_id: string }).registration_id)} for session exit.` }],
    },
    async execute(args, exec) {
      if (!exec.agent) throw new Error("atexit_register requires an owning agent session");
      const input = args as { argv: string[]; cwd?: string; key?: string; timeout_ms?: number };
      const binding = bindingFor(exec.agent);
      const registration = await store.register({ argv: input.argv as [string, ...string[]], cwd: input.cwd ?? binding.cwd, ...(input.key === undefined ? {} : { key: input.key }), ...(input.timeout_ms === undefined ? {} : { timeoutMs: input.timeout_ms }) });
      const result = await store.bind(registration.id, binding);
      if (result.lateRun) startRun(result.lateRun);
      return { registration_id: registration.id, state: result.registration.state };
    },
  }));
  ctx.tools.register(defineTool({
    name: "atexit_cancel",
    description: "Cancel a pending atexit registration by its unguessable registration ID.",
    parameters: { registration_id: { type: "string", required: true } },
    output: {
      schema: { type: "object", additionalProperties: false, properties: { cancelled: { type: "boolean", required: true }, registration_id: { type: "string", required: true }, state: { type: "string", required: true } } },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
    },
    async execute(args) {
      const input = args as { registration_id: string };
      const result = await store.cancel(input.registration_id);
      return { cancelled: result.cancelled, registration_id: input.registration_id, state: result.registration.state };
    },
  }));
  ctx.tools.register(defineTool({
    name: "atexit_list",
    description: "Inspect atexit registrations by IDs previously returned to this session.",
    parameters: { registration_ids: { type: "array", required: true, items: { type: "string" } } },
    output: {
      schema: { type: "object", additionalProperties: false, properties: { registrations: { type: "array", required: true, items: { type: "object", additionalProperties: false, properties: { registration_id: { type: "string", required: true }, state: { type: "string", required: true } } } } } },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
    },
    async execute(args) {
      const input = args as { registration_ids: string[] };
      const registrations = await store.list(input.registration_ids);
      return { registrations: registrations.map((registration) => ({ registration_id: registration.id, state: registration.state })) };
    },
  }));
}
