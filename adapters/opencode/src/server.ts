import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ActionStore, resolveStateRoot, type RunRecord, type SessionBinding } from "../../../packages/core/src/index.ts";
import { tool, type PluginModule, type ToolContext } from "@opencode-ai/plugin";

const root = resolveStateRoot();
const store = new ActionStore(root);
const sessions = new Map<string, SessionBinding>();
const cleanupInstruction = "For a temporary browser session or background process left running across tool calls, register its exact cleanup argv with atexit_register once the real target is known. Never use placeholders or guessed handles. Register before creation only if cleanup safely tolerates the known target's absence; if creation assigns the target, register in the first response after receiving it. Use parallel tool calls for ready registry updates and independent work in the same response. Avoid a registry-only response when such work is ready, without delaying registration to find a batch partner. After successful normal cleanup or confirmation that creation left no resource, cancel its registration in parallel with independent remaining work, including cleanup of other resources. Cancellation removes the fallback without executing cleanup, so never run it in parallel with its own cleanup. With programmable orchestration, await and check cleanup success, then cancel in the same invocation. If nothing independent remains, call alone; do not invent work or split efficient cleanup to fill a batch. For an ego-browser task space, use argv [\"ego-browser\", \"nodejs\", \"-e\", \"await completeTaskSpace(<id>, { keep: false })\"].";

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
    "experimental.chat.system.transform": async (_input, output) => { output.system.push(cleanupInstruction); },
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
        description: `${cleanupInstruction} argv executes directly, without a shell.`,
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
        description: "After successful manual cleanup or confirmation that creation left no resource, cancel its fallback in parallel with independent remaining work, including cleanup of other resources. This only removes the registration; it does not execute cleanup. Never cancel in parallel with its own cleanup, since failure would leave no fallback. Use a separate call only if no independent work remains. Claimed or running commands cannot be cancelled.",
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
