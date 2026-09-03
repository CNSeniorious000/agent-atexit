import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ActionStore, resolveStateRoot, type RunRecord, type SessionBinding } from "@agent-atexit/core";
import { tool, type PluginModule, type ToolContext } from "@opencode-ai/plugin";

const root = resolveStateRoot();
const store = new ActionStore(root);
const sessions = new Map<string, SessionBinding>();

function startRun(run: RunRecord): void {
  const worker = fileURLToPath(new URL("./worker.js", import.meta.url));
  const child = spawn("node", [worker, "--state-dir", root, "--run-id", run.id], { detached: true, env: { ...process.env, AGENT_ATEXIT_STATE_DIR: root }, stdio: "ignore" });
  child.unref();
}

function binding(context: ToolContext): SessionBinding {
  const value = { cwd: context.directory, host: "opencode", sessionId: context.sessionID };
  sessions.set(context.sessionID, value);
  return value;
}

async function closeSession(value: SessionBinding): Promise<void> {
  const run = await store.closeAndClaim(value);
  if (run) startRun(run);
}

const plugin: PluginModule = {
  id: "agent-atexit.opencode",
  server: async () => ({
    dispose: async () => {
      await Promise.all([...sessions.values()].map(closeSession));
    },
    event: async ({ event }) => {
      if (event.type !== "session.deleted") return;
      const sessionId = event.properties.info.id;
      const value = sessions.get(sessionId);
      if (value) await closeSession(value);
    },
    tool: {
      atexit_register: tool({
        description: "Register an argv command to run once, in LIFO order, when this OpenCode instance exits or the session is deleted. This call authorizes delayed command execution; shell expansion is never used.",
        args: {
          argv: tool.schema.array(tool.schema.string().min(1)).min(1),
          cwd: tool.schema.string().optional(),
          key: tool.schema.string().min(1).max(128).optional(),
          timeout_ms: tool.schema.number().int().min(100).max(86_400_000).optional(),
        },
        execute: async ({ argv, cwd, key, timeout_ms }, context) => {
          const effectiveCwd = cwd ?? context.directory;
          await context.ask({ always: [], metadata: { argv, cwd: effectiveCwd }, patterns: [JSON.stringify(argv)], permission: "atexit_register" });
          const registration = await store.register({ argv: argv as [string, ...string[]], cwd: effectiveCwd, ...(key === undefined ? {} : { key }), ...(timeout_ms === undefined ? {} : { timeoutMs: timeout_ms }) });
          const result = await store.bind(registration.id, binding(context));
          if (result.lateRun) startRun(result.lateRun);
          return JSON.stringify({ argv: result.registration.argv, registration_id: registration.id, state: result.registration.state });
        },
      }),
      atexit_cancel: tool({
        description: "Cancel a pending atexit registration by its unguessable registration ID.",
        args: { registration_id: tool.schema.string().uuid() },
        execute: async ({ registration_id }) => JSON.stringify(await store.cancel(registration_id)),
      }),
      atexit_list: tool({
        description: "Inspect atexit registrations by IDs previously returned to this session.",
        args: { registration_ids: tool.schema.array(tool.schema.string().uuid()).min(1).max(100) },
        execute: async ({ registration_ids }) => JSON.stringify({ registrations: await store.list(registration_ids) }),
      }),
    },
  }),
};

export default plugin;

