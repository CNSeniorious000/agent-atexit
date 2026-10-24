import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ActionStore } from "../../../packages/core/src/index.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "atexit-isolation-")), saved = process.env.AGENT_ATEXIT_STATE_DIR;
  process.env.AGENT_ATEXIT_STATE_DIR = root;
  const plugin = (await import(pathToFileURL(resolve(import.meta.dirname, "../dist/server.js")).href)).default;
  const hooks = () => plugin.server({ directory: root });
  const context = (sessionID: string) => ({ sessionID, directory: root, worktree: root, agent: "build", messageID: "message", abort: new AbortController().signal, metadata() {}, async ask() {} });
  const argv = (name: string) => [process.execPath, "-e", `require('fs').writeFileSync(${JSON.stringify(join(root, name))}, 'done')`];
  const wait = async (name: string) => { for (let i = 0; i < 100 && !await Bun.file(join(root, name)).exists(); i++) await Bun.sleep(20); expect(await readFile(join(root, name), "utf8")).toBe("done"); };
  return { root, hooks, context, argv, wait, async close() { if (saved === undefined) delete process.env.AGENT_ATEXIT_STATE_DIR; else process.env.AGENT_ATEXIT_STATE_DIR = saved; await rm(root, { recursive: true, force: true }); } };
}

test("disposing one instance preserves another instance's pending registration and rejects foreign IDs", async () => {
  const f = await fixture();
  try {
    const a = await f.hooks(), b = await f.hooks();
    const register = async (hooks: any, id: string) => JSON.parse(await hooks.tool.atexit_register.execute({ argv: f.argv(id) }, f.context(id))).registration_id;
    await register(a, "a"); const id = await register(b, "b");
    await expect(a.tool.atexit_cancel.execute({ registration_id: id }, f.context("a"))).rejects.toThrow("does not belong");
    await expect(a.tool.atexit_list.execute({ registration_ids: [id] }, f.context("a"))).rejects.toThrow("does not belong");
    await a.dispose(); await f.wait("a");
    expect((await new ActionStore(f.root).get(id)).state).toBe("pending");
    expect(await Bun.file(join(f.root, "b")).exists()).toBe(false);
    await b.dispose(); await f.wait("b");
  } finally { await f.close(); }
});

test("fresh instance deletion recovers persisted bindings and closes registrations arriving after deletion", async () => {
  const f = await fixture();
  try {
    const prior = await f.hooks();
    await prior.tool.atexit_register.execute({ argv: f.argv("persisted") }, f.context("persisted"));
    const fresh = await f.hooks();
    await fresh.event({ event: { type: "session.deleted", properties: { info: { id: "persisted" } } } });
    await f.wait("persisted");
    await fresh.event({ event: { type: "session.deleted", properties: { info: { id: "late" } } } });
    await fresh.tool.atexit_register.execute({ argv: f.argv("late") }, f.context("late"));
    await f.wait("late");
  } finally { await f.close(); }
});

test("resumed list and cancel enroll abandoned sessions for disposal without a new registration", async () => {
  for (const operation of ["list", "cancel"]) {
    const f = await fixture();
    try {
      const source = new URL("../../../packages/core/src/store.ts", import.meta.url).pathname;
      const code = `const { ActionStore } = await import(${JSON.stringify(source)}); const store = new ActionStore(${JSON.stringify(f.root)}), binding = ${JSON.stringify({ cwd: f.root, host: "opencode", sessionId: "resume", generation: "exited" })}; await store.openSession(binding); const ids = []; for (const argv of ${JSON.stringify([f.argv("first"), f.argv("remaining")])}) { const record = await store.register({argv}); await store.bind(record.id, binding); ids.push(record.id); } console.log(JSON.stringify(ids));`;
      const child = Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe" });
      const [output, errors, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(errors).toBe(""); expect(exit).toBe(0);
      const ids = JSON.parse(output), hooks = await f.hooks(), context = f.context("resume"), store = new ActionStore(f.root);
      if (operation === "list") await hooks.tool.atexit_list.execute({ registration_ids: ids }, context);
      else await hooks.tool.atexit_cancel.execute({ registration_id: ids[0] }, context);
      expect((await store.get(ids[1])).state).toBe("pending");
      await hooks.dispose(); await f.wait("remaining");
      if (operation === "list") await f.wait("first");
      else { expect((await store.get(ids[0])).state).toBe("cancelled"); expect(await Bun.file(join(f.root, "first")).exists()).toBe(false); }
    } finally { await f.close(); }
  }
});

test("failed worker spawn executes the claimed run in-process", async () => {
  const f = await fixture(), path = process.env.PATH;
  try {
    const hooks = await f.hooks();
    await hooks.tool.atexit_register.execute({ argv: f.argv("fallback") }, f.context("fallback"));
    process.env.PATH = f.root;
    await hooks.dispose();
    await f.wait("fallback");
  } finally { if (path === undefined) delete process.env.PATH; else process.env.PATH = path; await f.close(); }
});

test("resuming a disposed session keeps new cleanup pending and repeated old disposal cannot close it", async () => {
  const f = await fixture();
  try {
    const first = await f.hooks();
    await first.tool.atexit_register.execute({ argv: f.argv("old") }, f.context("resume"));
    await first.dispose(); await f.wait("old");
    const resumed = await f.hooks();
    const result = JSON.parse(await resumed.tool.atexit_register.execute({ argv: f.argv("new") }, f.context("resume")));
    await first.dispose();
    expect((await new ActionStore(f.root).get(result.registration_id)).state).toBe("pending");
    expect(await Bun.file(join(f.root, "new")).exists()).toBe(false);
    await expect(first.tool.atexit_register.execute({ argv: f.argv("stale") }, f.context("resume"))).rejects.toThrow("disposed");
    await resumed.dispose(); await f.wait("new");
  } finally { await f.close(); }
});

test("deletion while registration waits for permission cannot be undone by reopening", async () => {
  const f = await fixture(), saved = process.env.AGENT_ATEXIT_ASK;
  try {
    const hooks = await f.hooks(), waiting = Promise.withResolvers<void>(), proceed = Promise.withResolvers<void>();
    process.env.AGENT_ATEXIT_ASK = "1";
    const registration = hooks.tool.atexit_register.execute({ argv: f.argv("raced") }, { ...f.context("race"), async ask() { waiting.resolve(); await proceed.promise; } });
    await waiting.promise;
    await hooks.event({ event: { type: "session.deleted", properties: { info: { id: "race" } } } });
    proceed.resolve(); await registration; await f.wait("raced");
  } finally { if (saved === undefined) delete process.env.AGENT_ATEXIT_ASK; else process.env.AGENT_ATEXIT_ASK = saved; await f.close(); }
});

test("old permission waiter cannot replace resumed cleanup with the same key", async () => {
  const f = await fixture(), saved = process.env.AGENT_ATEXIT_ASK;
  try {
    const old = await f.hooks(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    process.env.AGENT_ATEXIT_ASK = "1";
    const stale = old.tool.atexit_register.execute({ argv: f.argv("stale-waiter"), key: "shared" }, { ...f.context("resume"), async ask() { entered.resolve(); await release.promise; } });
    await entered.promise; await old.dispose(); delete process.env.AGENT_ATEXIT_ASK;
    const resumed = await f.hooks();
    const fresh = JSON.parse(await resumed.tool.atexit_register.execute({ argv: f.argv("fresh-waiter"), key: "shared" }, f.context("resume")));
    release.resolve(); await stale; await f.wait("stale-waiter");
    expect((await new ActionStore(f.root).get(fresh.registration_id)).state).toBe("pending");
    expect(await Bun.file(join(f.root, "fresh-waiter")).exists()).toBe(false);
    await resumed.dispose(); await f.wait("fresh-waiter");
  } finally { if (saved === undefined) delete process.env.AGENT_ATEXIT_ASK; else process.env.AGENT_ATEXIT_ASK = saved; await f.close(); }
});

test("overlapping instance lifetimes drain only their own generation", async () => {
  const f = await fixture();
  try {
    const old = await f.hooks(), resumed = await f.hooks();
    await old.tool.atexit_register.execute({ argv: f.argv("old-overlap") }, f.context("same"));
    const fresh = JSON.parse(await resumed.tool.atexit_register.execute({ argv: f.argv("new-overlap") }, f.context("same")));
    await old.dispose(); await f.wait("old-overlap");
    expect((await new ActionStore(f.root).get(fresh.registration_id)).state).toBe("pending");
    expect(await Bun.file(join(f.root, "new-overlap")).exists()).toBe(false);
    await resumed.dispose(); await f.wait("new-overlap");
  } finally { await f.close(); }
});

test("failed opens and failed disposal can retry after filesystem recovery", async () => {
  const f = await fixture();
  const { rename, writeFile } = await import("node:fs/promises");
  const breakSessions = async () => { await rename(join(f.root, "sessions"), join(f.root, "saved-sessions")); await writeFile(join(f.root, "sessions"), "blocked"); };
  const restore = async () => { await rm(join(f.root, "sessions")); await rename(join(f.root, "saved-sessions"), join(f.root, "sessions")); };
  try {
    await new ActionStore(f.root).init(); const hooks = await f.hooks();
    await breakSessions();
    await expect(hooks.tool.atexit_register.execute({ argv: f.argv("retry") }, f.context("retry"))).rejects.toThrow();
    await restore();
    await hooks.tool.atexit_register.execute({ argv: f.argv("retry") }, f.context("retry"));
    await breakSessions(); await expect(hooks.dispose()).rejects.toThrow(); await restore();
    await hooks.dispose(); await f.wait("retry");
  } finally { await f.close(); }
});

test("concurrent disposal callers await the same close", async () => {
  const f = await fixture();
  const { mkdir } = await import("node:fs/promises");
  const { sessionKey } = await import("../../../packages/core/src/index.ts");
  try {
    const hooks = await f.hooks(); await hooks.tool.atexit_register.execute({ argv: f.argv("concurrent") }, f.context("same"));
    const lock = join(f.root, "locks", "session-" + sessionKey("opencode", "same")); await mkdir(lock);
    const first = hooks.dispose(); let returned = false;
    const second = hooks.dispose().then(() => { returned = true; });
    await Bun.sleep(50); expect(returned).toBe(false); await rm(lock, { recursive: true });
    await Promise.all([first, second]); await f.wait("concurrent");
  } finally { await f.close(); }
});

test("deletion drains persisted cleanup even when the new instance's open failed", async () => {
  const f = await fixture(), { rename, writeFile } = await import("node:fs/promises");
  try {
    const old = await f.hooks(); await old.tool.atexit_register.execute({ argv: f.argv("persisted-after-failure") }, f.context("same"));
    const fresh = await f.hooks();
    await rename(join(f.root, "sessions"), join(f.root, "saved-sessions")); await writeFile(join(f.root, "sessions"), "blocked");
    await expect(fresh.tool.atexit_register.execute({ argv: f.argv("unregistered") }, f.context("same"))).rejects.toThrow();
    await rm(join(f.root, "sessions")); await rename(join(f.root, "saved-sessions"), join(f.root, "sessions"));
    await fresh.event({ event: { type: "session.deleted", properties: { info: { id: "same" } } } });
    await f.wait("persisted-after-failure");
  } finally { await f.close(); }
});

test("permanent deletion remains terminal in a fresh instance without an in-memory deleted set", async () => {
  const f = await fixture();
  try {
    const first = await f.hooks(); await first.event({ event: { type: "session.deleted", properties: { info: { id: "gone" } } } });
    const fresh = await f.hooks();
    const result = JSON.parse(await fresh.tool.atexit_register.execute({ argv: f.argv("deleted") }, f.context("gone")));
    expect(result.state).toBe("claimed"); await f.wait("deleted");
  } finally { await f.close(); }
});
