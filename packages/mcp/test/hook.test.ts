import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ActionStore } from "@agent-atexit/core";
import { consumeKimiApproval } from "../src/kimi-approval.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function runHook(root: string, input: unknown): Promise<void> {
  const hook = resolve(import.meta.dirname, "../../../plugins/atexit/dist/hook.mjs");
  const child = spawn("node", [hook], { env: { ...process.env, AGENT_ATEXIT_RUN_INLINE: "1", AGENT_ATEXIT_STATE_DIR: root }, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  child.stdin.end(JSON.stringify(input));
  const [code] = (await once(child, "exit")) as [number | null];
  if (code !== 0) throw new Error(`hook exited ${String(code)}: ${stderr}`);
}

describe("portable lifecycle hook", () => {
  test("binds an MCP registration and executes it when the same session ends", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-atexit-hook-"));
    roots.push(root);
    const store = new ActionStore(root);
    const output = join(root, "executed.txt");
    const registration = await store.register({ argv: [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(output)}, 'done')`] });
    const common = { cwd: root, session_id: "session-a" };
    await runHook(root, { ...common, hook_event_name: "PostToolUse", tool_name: "mcp__atexit__atexit_register", tool_response: { structuredContent: { registration_id: registration.id } } });
    expect((await store.get(registration.id)).state).toBe("pending");
    await runHook(root, { ...common, hook_event_name: "SessionEnd", reason: "other" });
    expect(await readFile(output, "utf8")).toBe("done");
    expect((await store.get(registration.id)).state).toBe("succeeded");
  });

  test("does not claim another session's registration", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-atexit-hook-"));
    roots.push(root);
    const store = new ActionStore(root);
    const registration = await store.register({ argv: ["echo", "wrong session"] });
    await runHook(root, { cwd: root, hook_event_name: "PostToolUse", session_id: "session-a", tool_response: { registration_id: registration.id } });
    await runHook(root, { cwd: root, hook_event_name: "SessionEnd", reason: "other", session_id: "session-b" });
    expect((await store.get(registration.id)).state).toBe("pending");
  });

  test("records one-time Kimi approval proofs", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-atexit-hook-"));
    roots.push(root);
    const approval_id = randomUUID();
    const tool_input = { approval_id, argv: ["echo", "approved"] };
    await runHook(root, { client_type: "kimi_code_cli", cwd: root, decision: "approved", hook_event_name: "PermissionResult", session_id: "kimi-session", tool_call_id: "call-1", tool_input, tool_name: "mcp__plugin-atexit_atexit__atexit_register" });
    const proof = await consumeKimiApproval(root, tool_input);
    expect(proof).toMatchObject({ approvalId: approval_id, cwd: root, sessionId: "kimi-session", toolCallId: "call-1" });
    await expect(consumeKimiApproval(root, tool_input)).rejects.toThrow("already consumed");
  });
});
