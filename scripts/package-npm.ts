import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const artifacts = resolve(root, "artifacts");
const packages = ["adapters/opencode", "adapters/dsh"];

await mkdir(artifacts, { recursive: true });
for (const directory of packages) {
  const process = Bun.spawn(["bun", "pm", "pack", "--ignore-scripts", "--destination", artifacts], { cwd: resolve(root, directory), stderr: "inherit", stdout: "inherit" });
  if (await process.exited) throw new Error(`failed to pack ${directory}`);
}
