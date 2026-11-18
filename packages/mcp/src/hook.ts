import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ActionStore, executeRun, resolveStateRoot, type RunRecord, type SessionBinding } from "@agent-atexit/core";
import { claudeCleanupInstruction } from "./claude";
import { verificationFeedback } from "./verification";

interface HookInput {
  client_type?: string;
  cwd?: string;
  hook_event_name?: string;
  session_id?: string;
  tool_name?: string;
  tool_response?: unknown;
  tool_calls?: { tool_name?: string; tool_input?: { command?: unknown; content?: unknown; new_string?: unknown; newString?: unknown } }[];
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
    } catch { /* 非 JSON 文本不是注册结果，不能从中猜测归属。 */ }
  } else if (Array.isArray(value)) {
    for (const item of value) findRegistrationIds(item, found);
  } else if (value && typeof value === "object") {
    const result = value as Record<string, unknown>, id = result.registration_id ?? result.registrationId;
    if (typeof id === "string") found.add(id);
    // Hermes may serialize the MCP response inside its own result envelope.
    else for (const key of ["structuredContent", "content", "text", "result"]) findRegistrationIds(result[key], found);
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
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", () => { child.unref(); resolve(); });
    child.once("error", reject);
  }).catch(async (error) => {
    // The run is already claimed; attempt cleanup here rather than leave it permanently stranded.
    console.error("agent-atexit worker spawn failed; running cleanup in-process", error);
    await executeRun(root, run.id);
  });
}

async function main(): Promise<void> {
  const input = JSON.parse((await readStdin()) || "{}") as HookInput;
  if (!input.session_id || !input.cwd || !input.hook_event_name) return;
  const host = detectHost(input);
  if (input.hook_event_name === "PostToolBatch") {
    // Inspect arguments, not tool output: untrusted result text must not control this reminder or enter registration binding.
    if (host === "claude-code" && input.tool_calls?.some((call) => call.tool_name && !["TodoWrite", "TodoRead"].includes(call.tool_name))) {
      const feedback = verificationFeedback(input.tool_calls), hint = feedback ? "\n\n" + feedback : "";
      console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolBatch", additionalContext: claudeCleanupInstruction + hint } }));
    }
    return;
  }
  const postTool = input.hook_event_name === "PostToolUse" || input.hook_event_name === "post_tool_call";
  if (postTool && !["mcp__atexit__atexit_register", "mcp__plugin_atexit_atexit__atexit_register", "mcp__plugin-atexit_atexit__atexit_register"].includes(input.tool_name ?? "")) return;
  // Codex's legacy bundled-MCP format resolves cwd but does not expose PLUGIN_DATA to the server. Ignore the hook-only compatibility variables so both sides use the XDG state fallback.
  const root = host === "codex" ? resolveStateRoot({ ...process.env, CLAUDE_PLUGIN_DATA: undefined, PLUGIN_DATA: undefined }) : resolveStateRoot();
  const store = new ActionStore(root);
  const binding: SessionBinding = { cwd: input.cwd, host, sessionId: input.session_id };
  if (input.hook_event_name === "SessionStart") {
    await store.openSession(binding);
    return;
  }
  if (postTool) {
    for (const id of findRegistrationIds(input.tool_response ?? input.tool_output ?? input.extra?.result)) {
      const result = await store.bind(id, binding).catch((error: unknown) => {
        if (error && typeof error === "object" && "code" in error && error.code === "REGISTRATION_NOT_FOUND") return;
        const reason = error instanceof SyntaxError ? "invalid JSON in cleanup state" : error instanceof Error ? error.message : String(error);
        console.error(`atexit binding failed: ${host} session=${JSON.stringify(input.session_id)} registration=${id}: ${reason}`);
        process.exitCode = 1;
      });
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
