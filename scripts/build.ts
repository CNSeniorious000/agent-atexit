import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const portableDist = resolve(root, "plugins/atexit/dist");
const entries = [
  ["packages/mcp/src/server.ts", "mcp.mjs"],
  ["packages/mcp/src/hook.ts", "hook.mjs"],
  ["packages/mcp/src/worker.ts", "worker.mjs"],
] as const;

await rm(portableDist, { force: true, recursive: true });
await rm(resolve(root, "artifacts/portable-dist"), { force: true, recursive: true });
await mkdir(portableDist, { recursive: true });
for (const [entry, name] of entries) {
  const result = await Bun.build({ entrypoints: [resolve(root, entry)], external: [], format: "esm", minify: true, naming: name, outdir: portableDist, packages: "bundle", target: "node" });
  if (!result.success) throw new AggregateError(result.logs, `failed to build ${entry}`);
}
await mkdir(dirname(resolve(root, "artifacts/.keep")), { recursive: true });
await cp(portableDist, resolve(root, "artifacts/portable-dist"), { force: true, recursive: true });
