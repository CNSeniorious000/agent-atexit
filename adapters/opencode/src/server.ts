import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ActionStore, resolveStateRoot, type RunRecord, type SessionBinding } from "../../../packages/core/src/index.ts";
import { tool, type PluginModule, type ToolContext } from "@opencode-ai/plugin";

type ToolCall = { tool_name?: string; tool_input?: { command?: unknown; content?: unknown; new_string?: unknown; newString?: unknown; patchText?: unknown } };
// These are source-text hints, never a verdict about a resource or a shell parser.
function verificationFeedback(calls: readonly ToolCall[]): string {
  const locations: string[] = [], detachedPipes: string[] = [];
  for (const [index, call] of calls.entries()) {
    const tool = call.tool_name?.toLowerCase(), input = call.tool_input;
    const field = tool === "bash" ? "command" : tool === "write" ? "content" : tool === "edit" ? (input?.new_string !== undefined ? "new_string" : "newString") : tool === "apply_patch" ? "patchText" : undefined;
    const raw = field && input?.[field];
    // Only added patch lines are new source; keep their original line numbers for the hint.
    const source = typeof raw === "string" && tool === "apply_patch" ? raw.split("\n").map((line) => line.startsWith("+") && !line.startsWith("+++") ? line.slice(1) : "").join("\n") : raw;
    if (typeof source !== "string") continue;
    const line = (offset: number) => source.slice(0, offset).split("\n").length;
    const discarded = [...source.matchAll(/(?:\b2\s*>>?|(?:^|\s)&>>?)\s*["']?\/dev\/null["']?/g), ...source.matchAll(/(?<!\d)1?>>?\s*["']?\/dev\/null["']?\s+2>&1/g)].map((match) => line(match.index));
    // A resolving error callback can mistake any connection failure for absence; this is only a source hint.
    const ignoredEvents = [...source.matchAll(/\.\s*(?:on|once)\(\s*["']error["']\s*,\s*\(\s*\)\s*=>\s*(?:\{\s*)?resolve\s*\(/g)].map((match) => line(match.index));
    const caught: number[] = [];
    for (const match of source.matchAll(/\bcatch\s*(?:\(\s*([\w$]+)\s*\)\s*)?\{([^{}]*)\}/g)) {
      const body = match[2]!, parameter = match[1];
      // Propagating the failure or inspecting the caught error already preserves a useful distinction.
      if (/\bthrow\b|\breject\s*\(|\bprocess\.exit\s*\(\s*[1-9]/.test(body) || (parameter && new RegExp("(?:^|[^\\w$])" + parameter.replace(/[$]/g, "\\$") + "(?![\\w$])").test(body))) continue;
      caught.push(line(match.index));
    }
    // Merging stderr into a filtered pipe can hide errors just like redirecting it away.
    const filtered = [...source.matchAll(/(?:(?<!\d)2>&1\s*\||\|&)\s*(?:grep|rg|awk|sed)\b/g)].map((match) => line(match.index));
    const label = `tool ${index + 1} ${tool}.${field}`;
    // Explicit synchronous pipes retain stderr in the result/error; status alone can omit its diagnostics.
    const capturedStderr = /\bstdio\s*:\s*(?:["']pipe["']|\[\s*[^,\]]+\s*,\s*[^,\]]+\s*,\s*["']pipe["']\s*\])/.exec(source);
    if (/\b(?:execSync|execFileSync|spawnSync)\s*\(/.test(source) && capturedStderr) locations.push(`${label}: subprocess stderr captured at line ${line(capturedStderr.index)}`);
    // Curl's silent flag hides diagnostics unless show-error is also present; fragments are only advisory, not shell parsing.
    const silentCurl = [...source.matchAll(/\bcurl\b[^\n;&|]*/g)].filter((match) => {
      const flags = [...match[0].matchAll(/(?:^|\s)(?:-([a-zA-Z]+)|--(silent|show-error))(?=\s|["'`]|$)/g)];
      return flags.some((flag) => flag[1]?.includes("s") || flag[2] === "silent") && !flags.some((flag) => flag[1]?.includes("S") || flag[2] === "show-error");
    }).map((match) => line(match.index));
    if (silentCurl.length) locations.push(`${label}: curl diagnostics suppressed at lines ${[...new Set(silentCurl)].slice(0, 4).join(",")}`);
    const pipes = /\bstdio\s*:\s*(?:["']pipe["']|\[[^\]]*["']pipe["'][^\]]*\])/.exec(source);
    if (/\bdetached\s*:\s*true/.test(source) && pipes) detachedPipes.push(`${label}: piped stdio at line ${line(pipes.index)}`);
    if (filtered.length) locations.push(`${label}: stderr filtered at lines ${[...new Set(filtered)].slice(0, 4).join(",")}`);
    if (discarded.length) locations.push(`${label}: stderr discarded at lines ${[...new Set(discarded)].slice(0, 4).join(",")}`);
    if (caught.length) locations.push(`${label}: caught errors discarded at lines ${[...new Set(caught)].slice(0, 4).join(",")}`);
    if (ignoredEvents.length) locations.push(`${label}: error callbacks discard diagnostics at lines ${[...new Set(ignoredEvents)].slice(0, 4).join(",")}`);
    if (locations.length >= 3) break;
  }
  const diagnostics = locations.length ? `Verification warning (${locations.slice(0, 3).join("; ")}). A negative check with hidden diagnostics is not release proof, even if it prints success. For affected verification, obtain a returned result with visible errors or independent proof of that same fact before claiming absence or cancelling. Ignore unrelated matches.` : "";
  const lifetime = detachedPipes.length ? `Detached stdio warning (${detachedPipes.slice(0, 3).join("; ")}). If the child outlives its launcher, piped streams depend on that launcher even when forwarded to files. Detached mode and unref() leave these pipes attached. Before launching such a child, replace the pipes with file descriptors or ignore directly in spawn stdio options.` : "";
  return [diagnostics, lifetime].filter(Boolean).join("\n\n");
}

const root = resolveStateRoot();
const store = new ActionStore(root);
const sessions = new Map<string, SessionBinding>();
const cleanupInstruction = "Batch eligible bookkeeping with ready independent task tools, including cleanup. Planning and filler do not count. Respect task ordering and data dependencies.\n\nRegister returned PIDs or session handles in the next tool batch; readiness checks and planning cannot postpone it. Cancel only after an earlier result proves that exact target released; for a PID, require process exit. Sibling calls cannot supply prerequisites; use checked awaits inside orchestration or later responses. Standalone bookkeeping is valid only when no real work, including cleanup, remains. Do not infer absence from checks that hide their errors. Account for partial acquisition before retrying.";

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
      const reminderFor = (message: (typeof output.messages)[number]) => {
        const calls = message.parts.flatMap((part) => part.type === "tool" && (part.state.status === "completed" || part.state.status === "error") ? [{ tool_name: part.tool, tool_input: part.state.input }] : []);
        const feedback = verificationFeedback(calls), hint = feedback ? "\n\n" + feedback : "";
        return `\n\n<system-reminder>\n${cleanupInstruction}${hint}\n</system-reminder>`;
      };
      // Preserve native execution intervals in every request; completion order is otherwise absent from tool text.
      // The host retains this array; replace copied entries rather than the array itself.
      output.messages.forEach((message, messageIndex) => {
        if (message.info.role !== "assistant") return message;
        const reminder = reminderFor(message);
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
      output.messages.forEach((message, index) => {
        if (message.info.role !== "assistant") return;
        const reminder = reminderFor(message);
        const partIndex = message.parts.findLastIndex((part) => part.type === "tool" && part.tool !== "todowrite" && (part.state.status === "completed" || part.state.status === "error"));
        const part = message.parts[partIndex];
        if (part?.type !== "tool" || (part.state.status !== "completed" && part.state.status !== "error")) return;
        const original = part.state.status === "completed" ? part.state.output : part.state.error;
        if (original.endsWith(reminder)) return;
        // Keep prior request prefixes stable: moving this suffix can break provider session matching and signed context.
        // Request-only copies leave stored results unchanged, with one reminder per eligible assistant message.
        const state = part.state.status === "completed" ? { ...part.state, output: original + reminder } : { ...part.state, error: original + reminder };
        const parts = message.parts.slice(); parts[partIndex] = { ...part, state };
        output.messages[index] = { ...message, parts };
      });
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
        description: "Register runnable cleanup argv for a returned PID or CLI session handle in the next tool response, with ready independent work. Reuse a working executable; do not guess absolute paths. Preregistration requires a known target and absence-tolerant cleanup. argv runs without a shell.",
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
        description: "Cancel the returned registration ID without running its fallback. Before choosing this call, obtain a completed result proving that exact target is released or was never created. Sibling calls cannot supply this prerequisite; await and check cleanup inside orchestration or use a later response. Signal delivery, a closed port for a PID, and hidden inspection errors are not proof. Cleanup success counts only when every successful path guarantees release. Batch with remaining independent work, including other cleanup; standalone is valid when none remains. Claimed or running commands cannot be cancelled.",
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
