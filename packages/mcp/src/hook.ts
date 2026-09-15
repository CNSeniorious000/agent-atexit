import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ActionStore, executeRun, resolveStateRoot, type RunRecord, type SessionBinding } from "@agent-atexit/core";

interface HookInput {
  client_type?: string;
  cwd?: string;
  hook_event_name?: string;
  session_id?: string;
  tool_name?: string;
  tool_response?: unknown;
  tool_output?: unknown;
  extra?: { result?: unknown };
}

function detectHost(input: HookInput): string {
  if (input.hook_event_name === "post_tool_call" || input.hook_event_name === "on_session_finalize") return "hermes";
  if (input.client_type === "kimi_code_cli") return "kimi-code";
  if (process.env.PLUGIN_ROOT) return "codex";
  return "claude-code";
}

function findRegistrationIds(value: unknown, found = new Set<string>()): string[] {
  if (typeof value === "string") {
    try {
      findRegistrationIds(JSON.parse(value), found);
    } catch {
      for (const match of value.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi)) found.add(match[0]);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) findRegistrationIds(item, found);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if ((key === "registration_id" || key === "registrationId") && typeof item === "string") found.add(item);
      else findRegistrationIds(item, found);
    }
  }
  return [...found];
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function startRun(root: string, run: RunRecord): Promise<void> {
  if (process.env.AGENT_ATEXIT_RUN_INLINE === "1") {
    await executeRun(root, run.id);
    return;
  }
  const worker = fileURLToPath(new URL("./worker.mjs", import.meta.url));
  const child = spawn(process.execPath, [worker, "--state-dir", root, "--run-id", run.id], { detached: true, env: { ...process.env, AGENT_ATEXIT_STATE_DIR: root }, stdio: "ignore" });
  child.unref();
}

async function main(): Promise<void> {
  const input = JSON.parse((await readStdin()) || "{}") as HookInput;
  if (!input.session_id || !input.cwd || !input.hook_event_name) return;
  const host = detectHost(input);
  // Codex's legacy bundled-MCP format resolves cwd but does not expose PLUGIN_DATA to the server. Ignore the hook-only compatibility variables so both sides use the XDG state fallback.
  const root = host === "codex" ? resolveStateRoot({ ...process.env, CLAUDE_PLUGIN_DATA: undefined, PLUGIN_DATA: undefined }) : resolveStateRoot();
  const store = new ActionStore(root);
  const binding: SessionBinding = { cwd: input.cwd, host, sessionId: input.session_id };
  if (input.hook_event_name === "PostToolUse" || input.hook_event_name === "post_tool_call") {
    for (const id of findRegistrationIds(input.tool_response ?? input.tool_output ?? input.extra?.result)) {
      const result = await store.bind(id, binding).catch(() => undefined);
      if (result?.lateRun) await startRun(root, result.lateRun);
    }
    return;
  }
  // Hermes on_session_end is a turn boundary; only on_session_finalize ends resource ownership.
  if (input.hook_event_name === "SessionEnd" || input.hook_event_name === "on_session_finalize") {
    const run = await store.closeAndClaim(binding);
    if (run) await startRun(root, run);
  }
}

await main();
