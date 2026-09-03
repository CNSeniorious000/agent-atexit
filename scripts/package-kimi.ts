import { readFile, readdir, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { zipSync } from "fflate";

const root = resolve(import.meta.dirname, "..");
const pluginRoot = resolve(root, "adapters/kimi-code");

async function collect(directory: string, output: Record<string, Uint8Array>): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "package.json") continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await collect(path, output);
    else output[relative(pluginRoot, path).split(sep).join("/")] = new Uint8Array(await readFile(path));
  }
}

const files: Record<string, Uint8Array> = {};
await collect(pluginRoot, files);
await writeFile(resolve(root, "artifacts/agent-atexit-kimi.zip"), zipSync(files, { level: 9 }));

