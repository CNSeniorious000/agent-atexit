import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { PluginModule, ToolContext } from "@opencode-ai/plugin";

const roots: string[] = [];

afterEach(async () => {
  delete process.env.AGENT_ATEXIT_ASK;
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

describe("OpenCode adapter", () => {
  test("defaults to no approval, binds to ToolContext.sessionID, and drains on dispose", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-atexit-opencode-"));
    roots.push(root);
    process.env.AGENT_ATEXIT_STATE_DIR = root;
    const url = pathToFileURL(resolve(import.meta.dirname, "../dist/server.js"));
    url.searchParams.set("test", crypto.randomUUID());
    const plugin = (await import(url.href)).default as PluginModule;
    const hooks = await plugin.server({} as never);
    const system = { system: ["host instructions"] };
    await hooks["experimental.chat.system.transform"]!({ model: {} as never }, system);
    expect(system.system).toHaveLength(2);
    expect(system.system[1]).toContain("register its exact cleanup argv with atexit_register");
    expect(system.system[1]).toContain('["ego-browser", "nodejs", "-e"');
    const output = join(root, "executed.txt");
    const approvals: unknown[] = [];
    const context = {
      abort: new AbortController().signal,
      agent: "build",
      ask: async (input: unknown) => { approvals.push(input); },
      directory: root,
      messageID: "message-a",
      metadata: () => undefined,
      sessionID: "session-a",
      worktree: root,
    } satisfies ToolContext;
    const result = await hooks.tool!.atexit_register!.execute({ argv: ["node", "-e", `require('node:fs').writeFileSync(${JSON.stringify(output)}, 'done')`] }, context);
    expect(approvals).toHaveLength(0);
    expect(JSON.parse(result as string)).toMatchObject({ state: "pending" });
    await hooks.dispose!();
    expect(await waitForFile(output)).toBe("done");
  });

  test("can ask before registering", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-atexit-opencode-"));
    roots.push(root);
    process.env.AGENT_ATEXIT_ASK = "1";
    process.env.AGENT_ATEXIT_STATE_DIR = root;
    const url = pathToFileURL(resolve(import.meta.dirname, "../dist/server.js"));
    url.searchParams.set("test", crypto.randomUUID());
    const plugin = (await import(url.href)).default as PluginModule;
    const hooks = await plugin.server({} as never);
    const approvals: unknown[] = [];
    const context = { abort: new AbortController().signal, agent: "build", ask: async (input: unknown) => { approvals.push(input); }, directory: root, messageID: "message-a", metadata: () => undefined, sessionID: "session-a", worktree: root } satisfies ToolContext;
    await hooks.tool!.atexit_register!.execute({ argv: ["/usr/bin/true"] }, context);
    expect(approvals).toHaveLength(1);
    await hooks.dispose!();
  });
});
