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
