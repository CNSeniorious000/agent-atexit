import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const portableDist = resolve(root, "plugins/atexit/dist");
const kimiDist = resolve(root, "adapters/kimi-code/dist");
const opencodeDist = resolve(root, "adapters/opencode/dist");
const dshDist = resolve(root, "adapters/dsh/dist");
const entries = [
  ["packages/mcp/src/server.ts", "mcp.mjs"],
  ["packages/mcp/src/hook.ts", "hook.mjs"],
  ["packages/mcp/src/worker.ts", "worker.mjs"],
] as const;

await rm(portableDist, { force: true, recursive: true });
await rm(kimiDist, { force: true, recursive: true });
await rm(opencodeDist, { force: true, recursive: true });
await rm(dshDist, { force: true, recursive: true });
await rm(resolve(root, "artifacts/portable-dist"), { force: true, recursive: true });
await mkdir(portableDist, { recursive: true });
for (const [entry, name] of entries) {
  const result = await Bun.build({ entrypoints: [resolve(root, entry)], external: [], format: "esm", minify: true, naming: name, outdir: portableDist, packages: "bundle", target: "node" });
  if (!result.success) throw new AggregateError(result.logs, `failed to build ${entry}`);
}
for (const [entry, name] of [["adapters/opencode/src/server.ts", "server.js"], ["adapters/opencode/src/worker.ts", "worker.js"]] as const) {
  const result = await Bun.build({ entrypoints: [resolve(root, entry)], external: [], format: "esm", minify: true, naming: name, outdir: opencodeDist, packages: "bundle", target: "node" });
  if (!result.success) throw new AggregateError(result.logs, `failed to build ${entry}`);
}
await cp(resolve(root, "plugins/atexit/skills"), resolve(opencodeDist, "skills"), { recursive: true });
for (const [entry, name, external] of [["adapters/dsh/src/index.ts", "index.js", ["@deepseek-ai/cordis", "@deepseek-ai/dsh-agent", "@deepseek-ai/dsh-tools", "@deepseek-ai/schemastery"]], ["adapters/dsh/src/worker.ts", "worker.js", []]] as const) {
  const result = await Bun.build({ entrypoints: [resolve(root, entry)], external: [...external], format: "esm", minify: true, naming: name, outdir: dshDist, packages: "bundle", target: "node" });
  if (!result.success) throw new AggregateError(result.logs, `failed to build ${entry}`);
}
await mkdir(dirname(resolve(root, "artifacts/.keep")), { recursive: true });
await cp(portableDist, kimiDist, { force: true, recursive: true });
await cp(portableDist, resolve(root, "artifacts/portable-dist"), { force: true, recursive: true });
