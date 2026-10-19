import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { ActionStore, sessionKey } from "../../../packages/core/src/index.ts";

const roots: string[] = [];

afterEach(async () => {
  delete process.env.AGENT_ATEXIT_STATE_DIR;
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function waitForFile(path: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await readFile(path, "utf8").catch(() => undefined);
    if (value !== undefined) return value;
    await delay(20);
  }
  throw new Error(`timed out waiting for ${path}`);
}

describe("dsh adapter", () => {
  test("captures the effective directory per registration without changing session ownership", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-atexit-dsh-cwd-"));
    roots.push(root);
    process.env.AGENT_ATEXIT_STATE_DIR = root;
    const plugin = await import(pathToFileURL(resolve(import.meta.dirname, "../dist/index.js")).href);
    const tools = new Map<string, any>();
    const agent = { ctx: { effect: () => undefined }, session: { id: "directory-session", header: { cwd: root } } };
    let cwd = join(root, "first"), reads = 0;
    let detach!: () => void;
    plugin.apply({
      on: () => undefined,
      inject: (_names: string[], callback: (scoped: unknown) => () => void) => {
        detach = callback({ workingDirectory: { get: (session: unknown) => { expect(session).toBe(agent.session); reads++; return cwd; } } });
      },
      tools: { register: (tool: any) => tools.set(tool.name, tool) },
    });
    const register = (override?: string) => tools.get("atexit_register").execute({ argv: ["true"], ...(override === undefined ? {} : { cwd: override }) }, { agent });
    const first = await register();
    cwd = join(root, "second");
    const second = await register();
    const explicit = await register(join(root, "explicit"));
    detach();
    const legacy = await register();
    const ids = [first, second, explicit, legacy].map((result) => result.registration_id);
    const listed = await new ActionStore(root).list(ids);
    const records = ids.map((id) => listed.find((record) => record.id === id)!);
    expect(records.map((record) => record.cwd)).toEqual([join(root, "first"), join(root, "second"), join(root, "explicit"), root]);
    expect(reads).toBe(2);
    expect(records.every((record) => record.sessionKey === sessionKey("dsh", "directory-session") && record.host === "dsh")).toBe(true);
    for (const registration_id of ids) await tools.get("atexit_cancel").execute({ registration_id });
  });

  test("defaults to no approval, binds to the agent, and drains through one disposer", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-atexit-dsh-"));
    roots.push(root);
    process.env.AGENT_ATEXIT_STATE_DIR = root;
    const url = pathToFileURL(resolve(import.meta.dirname, "../dist/index.js"));
    url.searchParams.set("test", crypto.randomUUID());
    const plugin = await import(url.href) as { apply(ctx: unknown, config?: { ask?: boolean }): void };
    const tools = new Map<string, { execute(args: unknown, exec: unknown): Promise<unknown> }>();
    let preExecute: ((exec: { name: string }, next: () => Promise<unknown>) => Promise<unknown>) | undefined;
    const ctx = {
      inject: () => undefined,
      on: (event: string, callback: typeof preExecute) => { if (event === "tools/pre-execute") preExecute = callback; },
      tools: { register: (definition: { name: string; execute(args: unknown, exec: unknown): Promise<unknown> }) => { tools.set(definition.name, definition); return () => undefined; } },
    };
    plugin.apply(ctx);
    expect(await preExecute!({ name: "atexit_register" }, async () => ({ kind: "allow" }))).toMatchObject({ kind: "allow" });
    let disposer: (() => Promise<void>) | undefined;
    const agent = {
      ctx: { effect: (setup: () => () => Promise<void>) => { disposer = setup(); return () => undefined; } },
      session: { header: { cwd: root }, id: "session-a" },
    };
    const output = join(root, "executed.txt");
    const result = await tools.get("atexit_register")!.execute({ argv: ["node", "-e", `require('node:fs').writeFileSync(${JSON.stringify(output)}, 'done')`] }, { agent });
    expect(result).toMatchObject({ state: "pending" });
    await disposer!();
    expect(await waitForFile(output)).toBe("done");
  });

  test("can ask before registering when configured", async () => {
    const url = pathToFileURL(resolve(import.meta.dirname, "../dist/index.js"));
    url.searchParams.set("test", crypto.randomUUID());
    const plugin = await import(url.href) as { apply(ctx: unknown, config?: { ask?: boolean }): void };
    let preExecute: ((exec: { name: string }, next: () => Promise<unknown>) => Promise<unknown>) | undefined;
    const ctx = {
      inject: () => undefined,
      on: (event: string, callback: typeof preExecute) => { if (event === "tools/pre-execute") preExecute = callback; },
      tools: { register: () => () => undefined },
    };
    plugin.apply(ctx, { ask: true });
    expect(await preExecute!({ name: "atexit_register" }, async () => ({ kind: "allow" }))).toMatchObject({ kind: "ask" });
  });

  test("drains an archived session once across duplicate lifecycle signals", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-atexit-dsh-"));
    roots.push(root);
    process.env.AGENT_ATEXIT_STATE_DIR = root;
    const url = pathToFileURL(resolve(import.meta.dirname, "../dist/index.js"));
    url.searchParams.set("test", crypto.randomUUID());
    const plugin = await import(url.href) as { apply(ctx: unknown): void };
    const tools = new Map<string, { execute(args: unknown, exec: unknown): Promise<unknown> }>();
    const listeners = new Map<string, (...args: unknown[]) => unknown>();
    const ctx = {
      inject: () => undefined,
      logger: { warn: () => undefined },
      on: (event: string, callback: (...args: unknown[]) => unknown) => { listeners.set(event, callback); return () => true; },
      tools: { register: (definition: { name: string; execute(args: unknown, exec: unknown): Promise<unknown> }) => { tools.set(definition.name, definition); return () => undefined; } },
    };
    plugin.apply(ctx);
    let disposer: (() => Promise<void>) | undefined;
    const agent = {
      ctx: { effect: (setup: () => () => Promise<void>) => { disposer = setup(); return () => undefined; } },
      session: { header: { cwd: root }, id: "session-archive" },
    };
    const output = join(root, "executed.txt");
    await tools.get("atexit_register")!.execute({ argv: ["node", "-e", `require('node:fs').appendFileSync(${JSON.stringify(output)}, 'done')`] }, { agent });
    expect(await readFile(output, "utf8").catch(() => undefined)).toBeUndefined();
    const archive = { domain: "workspace", operation: "put", table: "", value: { archivedSessionIds: ["session-archive"] } };
    listeners.get("domain/changed")!(archive);
    expect(await waitForFile(output)).toBe("done");
    listeners.get("domain/changed")!(archive);
    listeners.get("session/disposed")!({ id: "session-archive" });
    await disposer!();
    await delay(100);
    expect(await readFile(output, "utf8")).toBe("done");
  });
});
