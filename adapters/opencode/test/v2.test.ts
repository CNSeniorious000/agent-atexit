import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

for (const lifecycle of ["dispose", "session.deleted"] as const) test(`native v2 entry registers tools and drains on ${lifecycle}`, async () => {
  // Bundled plugin modules own process-wide stores; isolate native generations like their hosts do.
  if (!process.env.ATEXIT_V2_TEST_CHILD) {
    const child = Bun.spawn([process.execPath, "test", import.meta.path, "--test-name-pattern", lifecycle], { env: { ...process.env, ATEXIT_V2_TEST_CHILD: "1" }, stdout: "pipe", stderr: "pipe" });
    const [code, output] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (code) throw new Error(output);
    return;
  }
  const root = await mkdtemp("/tmp/atexit-v2-"), saved = process.env.AGENT_ATEXIT_STATE_DIR;
  process.env.AGENT_ATEXIT_STATE_DIR = root;
  const tools = new Map<string, any>(), hooks = new Map<string, any>(), permissions: unknown[] = [];
  let send: (event: unknown) => void = () => {};
  const plugin = (await import(pathToFileURL(resolve(import.meta.dirname, "../dist/server.js")).href + "?test=" + crypto.randomUUID())).default;
  try {
    expect(typeof plugin.server).toBe("function"); expect(typeof plugin.setup).toBe("function");
    const cleanup = await plugin.setup({
      location: { directory: root, project: { directory: root } },
      tool: { transform: async (fn: any) => fn({ add: (tool: any) => tools.set(tool.name, tool) }) },
      session: { hook: async (name: string, fn: any) => hooks.set(name, fn) },
      permission: { assert: async (request: unknown) => { permissions.push(request); } },
      event: { async *subscribe({ signal }: { signal: AbortSignal }) {
        while (!signal.aborted) {
          const event = await new Promise(resolve => { send = resolve; signal.addEventListener("abort", () => resolve(null), { once: true }); });
          if (event) yield event;
        }
      } },
    });
    expect([...tools.keys()].sort()).toEqual(["atexit_cancel", "atexit_list", "atexit_register"]);
    expect(tools.get("atexit_register").options).toEqual({ codemode: false });
    const context = { sessionID: "session-a", messageID: "message-a", agent: "build", signal: new AbortController().signal };
    const output = root + "/done";
    process.env.AGENT_ATEXIT_ASK = "1";
    const result = await tools.get("atexit_register").execute({ argv: ["node", "-e", `require('fs').writeFileSync(${JSON.stringify(output)}, 'done')`] }, context);
    delete process.env.AGENT_ATEXIT_ASK;
    expect(JSON.parse(result.content).state).toBe("pending");
    expect(permissions).toMatchObject([{ sessionID: "session-a", action: "atexit_register" }]);
    const event = { system: [] }; await hooks.get("context")(event); expect(JSON.stringify(event)).toContain("cleanup");
    if (lifecycle === "session.deleted") send({ type: lifecycle, data: { sessionID: "session-a" } });
    else await cleanup();
    for (let i = 0; i < 100 && !await Bun.file(output).exists(); i++) await Bun.sleep(20);
    expect(await readFile(output, "utf8")).toBe("done");
    if (lifecycle === "session.deleted") await cleanup();
  } finally {
    if (saved === undefined) delete process.env.AGENT_ATEXIT_STATE_DIR; else process.env.AGENT_ATEXIT_STATE_DIR = saved;
    delete process.env.AGENT_ATEXIT_ASK;
    await rm(root, { recursive: true, force: true });
  }
});
