import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionStore, executeRun } from "../src/index.ts";

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
