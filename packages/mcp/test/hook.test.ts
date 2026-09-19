import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ActionStore } from "@agent-atexit/core";

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

  test("binds Kimi registrations from PostToolUse output without an approval prompt", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-atexit-hook-"));
    roots.push(root);
    const store = new ActionStore(root);
    const registration = await store.register({ argv: ["echo", "deferred"] });
    await runHook(root, { client_type: "kimi_code_cli", cwd: root, hook_event_name: "PostToolUse", session_id: "kimi-session", tool_output: JSON.stringify({ registration_id: registration.id }), tool_name: "mcp__plugin-atexit_atexit__atexit_register" });
    expect(await store.get(registration.id)).toMatchObject({ host: "kimi-code", state: "pending" });
  });

  test("keeps Hermes cleanup across turns and runs it only at session finalization", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-atexit-hermes-"));
    roots.push(root);
    const store = new ActionStore(root);
    const output = join(root, "executed.txt");
    const registration = await store.register({ argv: [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(output)}, 'done')`] });
    const common = { cwd: root, session_id: "hermes-session" };
    await runHook(root, { ...common, hook_event_name: "post_tool_call", tool_name: "mcp__atexit__atexit_register", extra: { result: JSON.stringify({ registration_id: registration.id }) } });
    expect(await store.get(registration.id)).toMatchObject({ host: "hermes", state: "pending" });
    await runHook(root, { ...common, hook_event_name: "on_session_end" });
    expect((await store.get(registration.id)).state).toBe("pending");
    await runHook(root, { ...common, hook_event_name: "on_session_finalize" });
    expect(await readFile(output, "utf8")).toBe("done");
    expect((await store.get(registration.id)).state).toBe("succeeded");
  });

  test("SessionStart resumes cleanup ownership for tool calls sharing a session ID", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-atexit-resume-")); roots.push(root);
    const store = new ActionStore(root), common = { cwd: root, session_id: "same-thread" }, output = join(root, "executed.txt");
    await runHook(root, { ...common, hook_event_name: "SessionEnd", reason: "other" });
    await runHook(root, { ...common, hook_event_name: "SessionStart", source: "resume" });
    const registrations = [];
    for (const agent of ["root", "child"]) {
      const registration = await store.register({ argv: [process.execPath, "-e", `require('node:fs').appendFileSync(${JSON.stringify(output)}, ${JSON.stringify(agent + "\n")})`] });
      registrations.push(registration);
      await runHook(root, { ...common, agent_id: agent, hook_event_name: "PostToolUse", tool_response: { registration_id: registration.id } });
      expect((await store.get(registration.id)).state).toBe("pending");
    }
    await runHook(root, { ...common, hook_event_name: "SessionStart", source: "compact" });
    expect(await readFile(output, "utf8").catch(() => undefined)).toBeUndefined();
    await runHook(root, { ...common, hook_event_name: "SessionEnd", reason: "other" });
    expect((await readFile(output, "utf8")).trim().split("\n").sort()).toEqual(["child", "root"]);
    expect((await store.list(registrations.map(({ id }) => id))).every(({ state }) => state === "succeeded")).toBeTrue();
  });

  test("older writers remain pending after both first SessionStart and resume", async () => {
    for (const resumed of [false, true]) {
      const root = await mkdtemp(join(tmpdir(), "agent-atexit-legacy-")); roots.push(root);
      const store = new ActionStore(root), common = { cwd: root, session_id: "same-thread" }, output = join(root, "executed.txt");
      if (resumed) await runHook(root, { ...common, hook_event_name: "SessionEnd", reason: "other" });
      await runHook(root, { ...common, hook_event_name: "SessionStart", source: resumed ? "resume" : "startup" });
      const registration = await store.register({ argv: [process.execPath, "-e", "require('node:fs').writeFileSync(" + JSON.stringify(output) + ", 'closed')"] });
      delete registration.createdSequence; await store.writeRegistration(registration);
      await runHook(root, { ...common, hook_event_name: "PostToolUse", tool_response: { registration_id: registration.id } });
      expect((await store.get(registration.id)).state).toBe("pending");
      expect(await readFile(output, "utf8").catch(() => undefined)).toBeUndefined();
      await runHook(root, { ...common, hook_event_name: "SessionEnd", reason: "other" });
      expect(await readFile(output, "utf8")).toBe("closed");
      expect((await store.get(registration.id)).state).toBe("succeeded");
    }
  });

  test("a delayed old hook cannot execute or cancel the resumed session's replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-atexit-late-resume-")); roots.push(root);
    const store = new ActionStore(root), common = { cwd: root, session_id: "same-thread" }, output = join(root, "executed.txt");
    const old = await store.register({ argv: [process.execPath, "-e", `require('node:fs').appendFileSync(${JSON.stringify(output)}, 'old\\n')`], key: "server" });
    await runHook(root, { ...common, hook_event_name: "SessionEnd", reason: "other" });
    await runHook(root, { ...common, hook_event_name: "SessionStart", source: "resume" });
    const current = await store.register({ argv: [process.execPath, "-e", `require('node:fs').appendFileSync(${JSON.stringify(output)}, 'current\\n')`], key: "server" });
    await runHook(root, { ...common, hook_event_name: "PostToolUse", tool_response: { registration_id: current.id } });
    await runHook(root, { ...common, hook_event_name: "PostToolUse", tool_response: { registration_id: old.id } });
    expect(await readFile(output, "utf8")).toBe("old\n");
    expect((await store.get(current.id)).state).toBe("pending");
    await runHook(root, { ...common, hook_event_name: "SessionEnd", reason: "other" });
    expect(await readFile(output, "utf8")).toBe("old\ncurrent\n");
  });
});
