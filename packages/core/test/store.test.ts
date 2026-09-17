import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionStore, executeRun, sessionKey } from "../src/index.ts";

const roots: string[] = [];

async function makeStore(): Promise<{ root: string; store: ActionStore }> {
  const root = await mkdtemp(join(tmpdir(), "agent-atexit-test-"));
  roots.push(root);
  return { root, store: new ActionStore(root) };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("ActionStore", () => {
  test("rejects traversal IDs before lock recovery or run-lock creation touches sibling files", async () => {
    const { root } = await makeStore(), store = new ActionStore(join(root, "state")), victim = join(root, "victim");
    await store.init(); await mkdir(victim); await writeFile(join(victim, "keep.txt"), "untouched");
    const old = new Date(Date.now() - 60_000); await utimes(victim, old, old);
    const invalid = "../../../../victim", binding = { cwd: root, host: "test", sessionId: "invalid-id" };
    for (const operation of [() => store.cancel(invalid), () => store.bind(invalid, binding), () => store.acquireRun("../../victim/injected")]) {
      await expect(operation()).rejects.toThrow("invalid");
      expect(await readFile(join(victim, "keep.txt"), "utf8")).toBe("untouched");
      expect(await readdir(victim)).toEqual(["keep.txt"]);
    }
    expect(await readdir(join(root, "state/locks"))).toEqual([]);
    expect(await readdir(join(root, "state/runs"))).toEqual([]);
  });

  test("registers, binds, lists, and cancels a command", async () => {
    const { store } = await makeStore();
    const provisional = await store.register({ argv: ["echo", "hello"], key: "server" });
    expect(provisional.state).toBe("provisional");
    const bound = await store.bind(provisional.id, { cwd: "/tmp", host: "test", sessionId: "session-a" });
    expect(bound.registration).toMatchObject({ cwd: "/tmp", host: "test", state: "pending" });
    expect((await store.list([provisional.id]))[0]?.id).toBe(provisional.id);
    expect((await store.cancel(provisional.id)).cancelled).toBeTrue();
    expect((await store.closeAndClaim({ cwd: "/tmp", host: "test", sessionId: "session-a" }))).toBeUndefined();
  });

  test("replaces an older pending action with the same key", async () => {
    const { store } = await makeStore();
    const binding = { cwd: "/tmp", host: "test", sessionId: "session-a" };
    const first = await store.register({ argv: ["echo", "first"], key: "server" });
    await store.bind(first.id, binding);
    const second = await store.register({ argv: ["echo", "second"], key: "server" });
    await store.bind(second.id, binding);
    expect((await store.get(first.id)).state).toBe("cancelled");
    expect((await store.get(second.id)).state).toBe("pending");
  });

  test("claims a session once under concurrent close calls", async () => {
    const { store } = await makeStore();
    const binding = { cwd: "/tmp", host: "test", sessionId: "session-a" };
    const registrations = await Promise.all(["a", "b", "c"].map(async (value) => store.register({ argv: ["echo", value] })));
    await Promise.all(registrations.map(async (registration) => store.bind(registration.id, binding)));
    const runs = (await Promise.all([store.closeAndClaim(binding), store.closeAndClaim(binding)])).filter((run) => run !== undefined);
    expect(runs).toHaveLength(1);
    expect(new Set(runs[0]!.actionIds)).toEqual(new Set(registrations.map((registration) => registration.id)));
    expect((await store.closeAndClaim(binding))).toBeUndefined();
  });

  test("claims a late binding after the session is already closed", async () => {
    const { store } = await makeStore();
    const binding = { cwd: "/tmp", host: "test", sessionId: "session-a" };
    await store.closeAndClaim(binding);
    const registration = await store.register({ argv: ["echo", "late"] });
    const result = await store.bind(registration.id, binding);
    expect(result.lateRun?.actionIds).toEqual([registration.id]);
    expect(result.registration.state).toBe("claimed");
  });

  test("keeps delayed pre-resume cleanup separate from the same-key replacement with identical or backward timestamps", async () => {
    try {
      for (const resumedTime of ["2026-09-17T00:00:00Z", "2025-01-01T00:00:00Z"]) {
        setSystemTime(new Date("2026-09-17T00:00:00Z"));
        const { root, store } = await makeStore(), binding = { cwd: root, host: "test", sessionId: "resumed" }, output = join(root, "executed.txt");
        await store.closeAndClaim(binding);
        const old = await store.register({ argv: [process.execPath, "-e", `require('node:fs').appendFileSync(${JSON.stringify(output)}, 'old\\n')`], key: "server" });
        await store.openSession(binding);
        setSystemTime(new Date(resumedTime));
        const current = await store.register({ argv: [process.execPath, "-e", `require('node:fs').appendFileSync(${JSON.stringify(output)}, 'current\\n')`], key: "server" });
        expect(current.createdAt <= old.createdAt).toBeTrue();
        expect(current.createdSequence! > old.createdSequence!).toBeTrue();
        expect((await store.bind(current.id, binding)).registration.state).toBe("pending");
        const late = await store.bind(old.id, binding);
        expect(late.lateRun?.actionIds).toEqual([old.id]);
        expect((await store.get(current.id)).state).toBe("pending");
        await executeRun(root, late.lateRun!.id);
        expect(await readFile(output, "utf8")).toBe("old\n");
        const run = await store.closeAndClaim(binding);
        expect(run?.actionIds).toEqual([current.id]);
        await executeRun(root, run!.id);
        expect(await readFile(output, "utf8")).toBe("old\ncurrent\n");
      }
    } finally { setSystemTime(); }
  });

  test("keeps unknown legacy cleanup pending at first start and resume without replacing a current fallback", async () => {
    for (const resumed of [false, true]) for (const oldOrder of [undefined, 10_000]) {
      const { root, store } = await makeStore(), binding = { cwd: root, host: "test", sessionId: "mixed" }, output = join(root, "executed.txt");
      if (resumed) await store.closeAndClaim(binding);
      await store.openSession(binding);
      const session = JSON.parse(await readFile(join(root, "sessions", sessionKey(binding.host, binding.sessionId) + ".json"), "utf8")) as { openedSequence?: number };
      expect(session.openedSequence !== undefined).toBe(resumed);
      const current = await store.register({ argv: [process.execPath, "-e", "require('node:fs').appendFileSync(" + JSON.stringify(output) + ", 'current\\n')"], key: "server" });
      await store.bind(current.id, binding);
      const legacy = { ...await store.register({ argv: [process.execPath, "-e", "require('node:fs').appendFileSync(" + JSON.stringify(output) + ", 'legacy\\n')"], key: "server" }), createdOrder: oldOrder };
      delete legacy.createdSequence; await store.writeRegistration(legacy);
      if (oldOrder !== undefined) await writeFile(join(root, "order.json"), String(oldOrder));
      const bound = await store.bind(legacy.id, binding);
      expect(bound.lateRun).toBeUndefined(); expect(bound.registration.state).toBe("pending");
      expect((await store.get(current.id)).state).toBe("pending");
      expect(await readFile(output, "utf8").catch(() => undefined)).toBeUndefined();
      await executeRun(root, (await store.closeAndClaim(binding))!.id);
      expect((await readFile(output, "utf8")).trim().split("\n").sort()).toEqual(["current", "legacy"]);
    }
  });

  test("allocates unique sequences across processes and survives a rolled-back hint and old counter writes", async () => {
    const { root, store } = await makeStore(), source = new URL("../src/store.ts", import.meta.url).pathname;
    const code = "const { ActionStore } = await import(" + JSON.stringify(source) + "); const store = new ActionStore(" + JSON.stringify(root) + "); console.log(JSON.stringify((await Promise.all(Array.from({length:6}, () => store.register({argv:['echo','deferred']})))).map(record => record.createdSequence)));";
    const children = Array.from({ length: 4 }, () => Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe" }));
    try {
      const batches = await Promise.all(children.map(async (child) => {
        const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        expect(stderr).toBe(""); expect(code).toBe(0); return JSON.parse(stdout) as number[];
      }));
      const sequences = batches.flat();
      expect(new Set(sequences).size).toBe(24);
      await writeFile(join(root, "sequence.json"), "0\n"); await writeFile(join(root, "order.json"), "999999\n");
      const registration = await store.register({ argv: ["echo", "after rollback"] });
      expect(registration.createdSequence).toBe(Math.max(...sequences) + 1);
      expect(await readFile(join(root, "order.json"), "utf8")).toBe("999999\n");
    } finally { for (const child of children) child.kill(); await Promise.all(children.map((child) => child.exited)); }
  });

  test("a killed allocator leaves a consumed ticket without blocking another session", async () => {
    const { root, store } = await makeStore(), binding = { cwd: root, host: "test", sessionId: "resumed" }, source = new URL("../src/store.ts", import.meta.url).pathname;
    await store.closeAndClaim(binding);
    const code = [
      "import { mock } from 'bun:test'; import * as fs from 'node:fs/promises'; const rename = fs.rename;",
      "mock.module('node:fs/promises', () => ({ ...fs, rename: async (...args) => { if (args[1] === " + JSON.stringify(join(root, "sequence.json")) + ") { console.log('reserved'); setInterval(() => {}, 1000); await new Promise(() => {}); } return rename(...args); } }));",
      "const { ActionStore } = await import(" + JSON.stringify(source) + "); await new ActionStore(" + JSON.stringify(root) + ").register({argv:['echo','interrupted']});",
    ].join("\n");
    const child = Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const reader = child.stdout.getReader();
      const ready = await Promise.race([reader.read(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("allocator did not reserve a ticket")), 2_000); })]);
      reader.releaseLock(); expect(new TextDecoder().decode(ready.value).trim()).toBe("reserved");
      child.kill("SIGKILL"); await child.exited;
      const started = performance.now(), current = await store.register({ argv: ["echo", "current"] });
      await store.openSession(binding);
      expect(performance.now() - started).toBeLessThan(2_000);
      expect(current.createdSequence).toBe(2);
      expect(await readdir(join(root, "orders"))).toHaveLength(3);
      expect(await readdir(join(root, "locks"))).toEqual([]);
    } finally { clearTimeout(timer); child.kill("SIGKILL"); await child.exited; }
  });

  test("duplicate SessionStart preserves a live provisional registration", async () => {
    const { root, store } = await makeStore(), binding = { cwd: root, host: "test", sessionId: "live" }, output = join(root, "executed.txt");
    await store.openSession(binding);
    const registration = await store.register({ argv: [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(output)}, 'closed')`] });
    await store.openSession(binding);
    const bound = await store.bind(registration.id, binding);
    expect(bound.registration.state).toBe("pending");
    expect(bound.lateRun).toBeUndefined();
    expect(await readFile(output, "utf8").catch(() => undefined)).toBeUndefined();
    await executeRun(root, (await store.closeAndClaim(binding))!.id);
    expect(await readFile(output, "utf8")).toBe("closed");
  });

  test("a resumed session still claims concurrent bind and close exactly once", async () => {
    const { root, store } = await makeStore(), binding = { cwd: root, host: "test", sessionId: "racing" }, output = join(root, "executed.txt");
    await store.closeAndClaim(binding); await store.openSession(binding);
    const registration = await store.register({ argv: [process.execPath, "-e", `require('node:fs').appendFileSync(${JSON.stringify(output)}, 'once')`] });
    const [bound, closed] = await Promise.all([store.bind(registration.id, binding), store.closeAndClaim(binding)]);
    const runs = [bound.lateRun, closed].filter((run) => run !== undefined);
    expect(runs).toHaveLength(1); expect(runs[0]!.actionIds).toEqual([registration.id]);
    await executeRun(root, runs[0]!.id);
    expect(await readFile(output, "utf8")).toBe("once");
    expect(await store.closeAndClaim(binding)).toBeUndefined();
  });
});

describe("executeRun", () => {
  test("executes commands in LIFO order and never starts a run twice", async () => {
    const { root, store } = await makeStore();
    const output = join(root, "order.txt");
    const binding = { cwd: root, host: "test", sessionId: "session-a" };
    const first = await store.register({ argv: [process.execPath, "-e", `require('node:fs').appendFileSync(${JSON.stringify(output)}, 'first\\n')`] });
    await store.bind(first.id, binding);
    await new Promise((resolve) => setTimeout(resolve, 2));
    const second = await store.register({ argv: [process.execPath, "-e", `require('node:fs').appendFileSync(${JSON.stringify(output)}, 'second\\n')`] });
    await store.bind(second.id, binding);
    const run = await store.closeAndClaim(binding);
    expect(run).toBeDefined();
    expect((await executeRun(root, run!.id)).alreadyStarted).toBeFalse();
    expect(await readFile(output, "utf8")).toBe("second\nfirst\n");
    expect((await store.get(second.id)).state).toBe("succeeded");
    expect(await readFile(store.logPath(second.id), "utf8")).toContain(JSON.stringify(second.argv));
    expect((await executeRun(root, run!.id)).alreadyStarted).toBeTrue();
    expect(await readFile(output, "utf8")).toBe("second\nfirst\n");
  });

  test("does not retry a claimed run after a crash marker", async () => {
    const { root, store } = await makeStore();
    const output = join(root, "should-not-exist.txt");
    const binding = { cwd: root, host: "test", sessionId: "session-a" };
    const registration = await store.register({ argv: [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(output)}, 'duplicate')`] });
    await store.bind(registration.id, binding);
    const run = await store.closeAndClaim(binding);
    expect(run).toBeDefined();
    await (await store.acquireRun(run!.id))!.close();
    expect((await executeRun(root, run!.id)).alreadyStarted).toBeTrue();
    expect(await readFile(output, "utf8").catch(() => undefined)).toBeUndefined();
    expect((await store.get(registration.id)).state).toBe("claimed");
  });
});
