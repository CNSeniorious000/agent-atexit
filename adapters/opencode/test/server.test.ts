import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Hooks, PluginModule, ToolContext } from "@opencode-ai/plugin";

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
    const bundled = fileURLToPath(new URL("./skills/", url));
    for (const config of [{}, { skills: { paths: ["./user-skills"], urls: ["https://example.com/skills/"] } }] as (Parameters<NonNullable<Hooks["config"]>>[0] & { skills?: { paths?: string[]; urls?: string[] } })[]) {
      const original = structuredClone(config);
      await hooks.config!(config); await hooks.config!(config);
      expect(config.skills?.paths).toEqual([...(original.skills?.paths ?? []), bundled]);
      expect(config.skills?.urls).toEqual(original.skills?.urls);
    }
    expect(await readFile(join(bundled, "defer-cleanup/SKILL.md"), "utf8")).toBe(await readFile(resolve(import.meta.dirname, "../../../plugins/atexit/skills/defer-cleanup/SKILL.md"), "utf8"));
    const system = { system: ["host instructions"] };
    await hooks["experimental.chat.system.transform"]!({ model: {} as never }, system);
    expect(system.system).toHaveLength(2);
    expect(system.system[1]).toContain("fallback cleanup");
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

describe("OpenCode shell exit visibility", () => {
  async function hooks() {
    const root = await mkdtemp(join(tmpdir(), "agent-atexit-opencode-exit-"));
    roots.push(root); process.env.AGENT_ATEXIT_STATE_DIR = root;
    const url = pathToFileURL(resolve(import.meta.dirname, "../dist/server.js")); url.searchParams.set("test", crypto.randomUUID());
    return await ((await import(url.href)).default as PluginModule).server({} as never);
  }

  test("exposes silent success and failure without replacing stdout or metadata", async () => {
    const after = (await hooks())["tool.execute.after"]!;
    for (const exit of [0, 1, 127]) for (const text of ["(no output)", "line one\nline two\n", ""]) {
      const metadata = { exit, output: text, truncated: false }, output = { title: "original title", output: text, metadata };
      await after({ tool: "bash", sessionID: "session", callID: "call", args: {} }, output);
      expect(output.output).toBe(`${text}\n\n<shell_metadata>\nExit code: ${exit}\n</shell_metadata>`);
      expect(output.metadata).toBe(metadata); expect(output.metadata).toEqual({ exit, output: text, truncated: false }); expect(output.title).toBe("original title");
    }
  });

  test("preserves unrelated tools and unknown, null, or noninteger exit status", async () => {
    const after = (await hooks())["tool.execute.after"]!;
    for (const tool of ["bash", "read", "atexit_cancel"]) for (const metadata of [undefined, null, {}, { exit: undefined }, { exit: null }, { exit: "0" }, { exit: 1.5 }, { exit: NaN }, { exit: Infinity }, ...(tool === "bash" ? [] : [{ exit: 0 }, { exit: 1 }])]) {
      const output = { title: "unchanged", output: "original output", metadata }, original = structuredClone(output);
      await after({ tool, sessionID: "session", callID: "call", args: {} }, output);
      expect(output).toEqual(original); expect(output.metadata).toBe(metadata);
    }
  });
});
