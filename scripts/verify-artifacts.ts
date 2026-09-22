import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { unzipSync } from "fflate";

const root = resolve(import.meta.dirname, "..");
const artifacts = resolve(root, "artifacts");
const kimi = unzipSync(new Uint8Array(await readFile(resolve(artifacts, "agent-atexit-kimi.zip"))));
for (const path of ["kimi.plugin.json", "dist/mcp.mjs", "dist/hook.mjs", "dist/worker.mjs"]) if (!kimi[path]) throw new Error(`Kimi ZIP is missing ${path}`);

const tarballs = [
  { file: "agent-atexit-opencode-0.1.0.tgz", members: ["package/LICENSE", "package/README.md", "package/dist/server.js", "package/dist/skills/defer-cleanup/SKILL.md", "package/dist/worker.js", "package/package.json"], name: "@agent-atexit/opencode" },
  { file: "agent-atexit-dsh-0.1.0.tgz", members: ["package/LICENSE", "package/README.md", "package/cordis.patch.yml", "package/dist/index.js", "package/dist/worker.js", "package/package.json"], name: "@agent-atexit/dsh" },
] as const;

async function tarOutput(args: string[]): Promise<string> {
  const child = Bun.spawn(["tar", ...args], { stderr: "pipe", stdout: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`tar ${args.join(" ")} failed: ${stderr}`);
  return stdout;
}

for (const tarball of tarballs) {
  const path = resolve(artifacts, tarball.file);
  if ((await stat(path)).size === 0) throw new Error(`${tarball.file} is empty`);
  const members = (await tarOutput(["-tzf", path])).trim().split("\n").toSorted();
  if (JSON.stringify(members) !== JSON.stringify([...tarball.members].toSorted())) throw new Error(`${tarball.file} has unexpected members: ${members.join(", ")}`);
  const manifest = JSON.parse(await tarOutput(["-xOzf", path, "package/package.json"])) as { name?: string; publishConfig?: { access?: string }; version?: string };
  if (manifest.name !== tarball.name || manifest.version !== "0.1.0" || manifest.publishConfig?.access !== "public") throw new Error(`${tarball.file} has invalid package metadata`);
  if (tarball.name === "@agent-atexit/opencode" && await tarOutput(["-xOzf", path, "package/dist/skills/defer-cleanup/SKILL.md"]) !== await readFile(resolve(root, "plugins/atexit/skills/defer-cleanup/SKILL.md"), "utf8")) throw new Error(`${tarball.file} has stale cleanup guidance`);
}
