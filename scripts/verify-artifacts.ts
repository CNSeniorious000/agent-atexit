import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { unzipSync } from "fflate";

const root = resolve(import.meta.dirname, "..");
const artifacts = resolve(root, "artifacts");
const kimi = unzipSync(new Uint8Array(await readFile(resolve(artifacts, "agent-atexit-kimi.zip"))));
for (const path of ["kimi.plugin.json", "dist/mcp.mjs", "dist/hook.mjs", "dist/worker.mjs"]) if (!kimi[path]) throw new Error(`Kimi ZIP is missing ${path}`);
for (const path of ["agent-atexit-opencode-0.1.0.tgz", "agent-atexit-dsh-0.1.0.tgz"]) if ((await stat(resolve(artifacts, path))).size === 0) throw new Error(`${path} is empty`);

