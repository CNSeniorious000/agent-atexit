import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

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
  test("requests approval, binds to the agent, and drains through one disposer", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-atexit-dsh-"));
    roots.push(root);
    process.env.AGENT_ATEXIT_STATE_DIR = root;
    const url = pathToFileURL(resolve(import.meta.dirname, "../dist/index.js"));
    url.searchParams.set("test", crypto.randomUUID());
    const plugin = await import(url.href) as { apply(ctx: unknown): void };
    const tools = new Map<string, { execute(args: unknown, exec: unknown): Promise<unknown> }>();
    let preExecute: ((exec: { name: string }, next: () => Promise<unknown>) => Promise<unknown>) | undefined;
    const ctx = {
      on: (event: string, callback: typeof preExecute) => { if (event === "tools/pre-execute") preExecute = callback; },
      tools: { register: (definition: { name: string; execute(args: unknown, exec: unknown): Promise<unknown> }) => { tools.set(definition.name, definition); return () => undefined; } },
    };
    plugin.apply(ctx);
    expect(await preExecute!({ name: "atexit_register" }, async () => ({ kind: "allow" }))).toMatchObject({ kind: "ask" });
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
});
