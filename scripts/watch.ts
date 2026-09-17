import { watch } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const portableDist = resolve(root, "plugins/atexit/dist");
const kimiDist = resolve(root, "adapters/kimi-code/dist");
const opencodeDist = resolve(root, "adapters/opencode/dist");
const dshDist = resolve(root, "adapters/dsh/dist");
const sourceRoots = ["packages/core/src", "packages/mcp/src", "adapters/opencode/src", "adapters/dsh/src", "plugins/atexit/skills"].map((path) => resolve(root, path));

async function bundle(entry: string, name: string, outdir: string, external: string[] = []): Promise<void> {
  const result = await Bun.build({ entrypoints: [resolve(root, entry)], external, format: "esm", minify: true, naming: name, outdir, packages: "bundle", target: "node" });
  if (!result.success) throw new AggregateError(result.logs, `failed to build ${entry}`);
}

async function rebuild(): Promise<void> {
  await Promise.all([portableDist, kimiDist, opencodeDist, dshDist].map((path) => mkdir(path, { recursive: true })));
  await Promise.all([
    bundle("packages/mcp/src/server.ts", "mcp.mjs", portableDist),
    bundle("packages/mcp/src/hook.ts", "hook.mjs", portableDist),
    bundle("packages/mcp/src/worker.ts", "worker.mjs", portableDist),
    bundle("adapters/opencode/src/server.ts", "server.js", opencodeDist),
    bundle("adapters/opencode/src/worker.ts", "worker.js", opencodeDist),
    bundle("adapters/dsh/src/index.ts", "index.js", dshDist, ["@deepseek-ai/cordis", "@deepseek-ai/dsh-agent", "@deepseek-ai/dsh-tools", "@deepseek-ai/schemastery"]),
    bundle("adapters/dsh/src/worker.ts", "worker.js", dshDist),
  ]);
  await cp(portableDist, kimiDist, { force: true, recursive: true });
  // Copying alone retains deleted or renamed skills, so discovery would keep exposing stale instructions.
  await rm(resolve(opencodeDist, "skills"), { force: true, recursive: true });
  await cp(resolve(root, "plugins/atexit/skills"), resolve(opencodeDist, "skills"), { recursive: true });
  console.log(`rebuilt all adapters at ${new Date().toLocaleTimeString()}`);
}

let running = false;
let queued = false;
let timer: ReturnType<typeof setTimeout> | undefined;
async function run(): Promise<void> {
  if (running) { queued = true; return; }
  running = true;
  do {
    queued = false;
    try { await rebuild(); } catch (error) { console.error(error); }
  } while (queued);
  running = false;
}
function schedule(): void {
  clearTimeout(timer);
  timer = setTimeout(() => void run(), 50);
}

await run();
const watchers = sourceRoots.map((path) => watch(path, { recursive: true }, (_event, filename) => { if (filename?.endsWith(".ts") || filename?.endsWith(".md")) schedule(); }));
console.log("watching Claude Code, Codex, Kimi Code, OpenCode, and dsh adapter sources");
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { for (const watcher of watchers) watcher.close(); process.exit(0); });
await new Promise(() => {});
