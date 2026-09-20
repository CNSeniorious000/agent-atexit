import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ActionStore, resolveStateRoot, type RunRecord, type SessionBinding } from "../../../packages/core/src/index.ts";
import { tool, type PluginModule, type ToolContext } from "@opencode-ai/plugin";

const root = resolveStateRoot();
const store = new ActionStore(root);
const sessions = new Map<string, SessionBinding>();
const cleanupInstruction = "Register scoped fallback cleanup for temporary processes and CLI sessions kept live across tool calls. Cover all newly acquired resources as soon as their real cleanup targets are known. Avoid spending a model turn only on registry bookkeeping when independent task work is ready: use parallel calls or one orchestration invocation. Registration can accompany resource use or inspection. After cleanup succeeds, cancel its fallback alongside work on other resources, including their cleanup. Sequence dependencies within an invocation when possible. Never race cancellation with its own cleanup, delay registration, or invent work to fill a batch.";

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
    config: async (config) => {
      // OpenCode needs explicit plugin skill paths; its legacy SDK omits this config field.
      const skills = (config as typeof config & { skills?: { paths?: string[] } }).skills ??= {};
      skills.paths = [...new Set([...(skills.paths ?? []), fileURLToPath(new URL("./skills/", import.meta.url))])];
    },
    "experimental.chat.system.transform": async (_input, output) => { output.system.push(cleanupInstruction); },
    "experimental.chat.messages.transform": async (_input, output) => {
      const reminder = `\n\n<system-reminder>\n${cleanupInstruction}\n</system-reminder>`;
      // Preserve native execution intervals in every request; completion order is otherwise absent from tool text.
      // The host retains this array; replace copied entries rather than the array itself.
      output.messages.forEach((message, messageIndex) => {
        if (message.info.role !== "assistant") return message;
        let changed = false;
        const parts = message.parts.map((part) => {
          if (part.type !== "tool" || (part.state.status !== "completed" && part.state.status !== "error")) return part;
          const time = part.state.time;
          if (!time || ("compacted" in time && time.compacted !== undefined) || !Number.isInteger(time.start) || !Number.isInteger(time.end) || time.end < time.start) return part;
          const start = new Date(time.start), end = new Date(time.end);
          if (!Number.isFinite(start.valueOf()) || !Number.isFinite(end.valueOf())) return part;
          const timing = `\n\n<tool_timing start="${start.toISOString()}" end="${end.toISOString()}" />`;
          const original = part.state.status === "completed" ? part.state.output : part.state.error;
          if (original.endsWith(timing) || original.endsWith(timing + reminder)) return part;
          const state = part.state.status === "completed" ? { ...part.state, output: original + timing } : { ...part.state, error: original + timing };
          changed = true;
          return { ...part, state };
        });
        if (changed) output.messages[messageIndex] = { ...message, parts };
      });
      const index = output.messages.length - 1, message = output.messages[index];
      if (message?.info.role !== "assistant") return;
      const partIndex = message.parts.findLastIndex((part) => part.type === "tool" && part.tool !== "todowrite" && (part.state.status === "completed" || part.state.status === "error"));
      const part = message.parts[partIndex];
      if (part?.type !== "tool" || (part.state.status !== "completed" && part.state.status !== "error")) return;
      const original = part.state.status === "completed" ? part.state.output : part.state.error;
      if (original.endsWith(reminder)) return;
      // This is a request-only copy: preserve the stored result and never accumulate reminders in history.
      const state = part.state.status === "completed" ? { ...part.state, output: original + reminder } : { ...part.state, error: original + reminder };
      const parts = message.parts.slice(); parts[partIndex] = { ...part, state };
      output.messages[index] = { ...message, parts };
    },
    "tool.execute.after": async (input, output) => {
      // Legacy OpenCode keeps the exit code in metadata but omits it from the model-visible result.
      if (input.tool === "bash" && Number.isInteger(output.metadata?.exit)) output.output += `\n\n<shell_metadata>\nExit code: ${output.metadata.exit}\n</shell_metadata>`;
    },
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
        description: "Register scoped cleanup argv for a temporary process or CLI session kept live across calls. Cover all newly acquired resources in the first response after their real cleanup targets are known, alongside use, inspection, or other independent task work. Use parallel calls or one orchestration invocation to avoid a separate bookkeeping turn. Register before creation only if cleanup tolerates the known target's absence. argv executes directly, without a shell.",
        args: {
          argv: tool.schema.array(tool.schema.string().min(1)).min(1),
          cwd: tool.schema.string().optional(),
          key: tool.schema.string().min(1).max(128).optional(),
          timeout_ms: tool.schema.number().int().min(100).max(86_400_000).optional(),
        },
        execute: async ({ argv, cwd, key, timeout_ms }, context) => {
          const effectiveCwd = cwd ?? context.directory;
          if (process.env.AGENT_ATEXIT_ASK === "1") await context.ask({ always: [], metadata: { argv, cwd: effectiveCwd }, patterns: [JSON.stringify(argv)], permission: "atexit_register" });
          const registration = await store.register({ argv: argv as [string, ...string[]], cwd: effectiveCwd, ...(key === undefined ? {} : { key }), ...(timeout_ms === undefined ? {} : { timeoutMs: timeout_ms }) });
          const result = await store.bind(registration.id, binding(context));
          if (result.lateRun) startRun(result.lateRun);
          return JSON.stringify({ argv: result.registration.argv, registration_id: registration.id, state: result.registration.state });
        },
      }),
      atexit_cancel: tool({
        description: "Remove a fallback without executing it. Confirm resource release before cancelling; a stop acknowledgment alone is insufficient. Never parallelize cancellation with its cleanup or the check establishing release. Then combine cancellation with independent remaining work, including cleanup of other resources. A separate call is appropriate when none remains. Creation confirmed to have left no resource also permits cancellation. Claimed or running commands cannot be cancelled.",
        args: { registration_id: tool.schema.string().uuid() },
        execute: async ({ registration_id }) => JSON.stringify(await store.cancel(registration_id)),
      }),
      atexit_list: tool({
        description: "Inspect atexit registrations by IDs previously returned to this session. Avoid spending a model turn only on registry bookkeeping when independent task work is ready.",
        args: { registration_ids: tool.schema.array(tool.schema.string().uuid()).min(1).max(100) },
        execute: async ({ registration_ids }) => JSON.stringify({ registrations: await store.list(registration_ids) }),
      }),
    },
  }),
};

export default plugin;
