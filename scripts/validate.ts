import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const readJson = async (path: string) => JSON.parse(await readFile(resolve(root, path), "utf8")) as Record<string, unknown>;
const expectedVersion = "0.1.0";
const manifests = [
  "plugins/atexit/.claude-plugin/plugin.json",
  "plugins/atexit/.codex-plugin/plugin.json",
  "adapters/kimi-code/kimi.plugin.json",
  "adapters/opencode/package.json",
  "adapters/dsh/package.json",
];

for (const path of manifests) {
  const manifest = await readJson(path);
  if (manifest.version !== expectedVersion) throw new Error(`${path} must use version ${expectedVersion}`);
  if (manifest.name !== "atexit" && manifest.name !== "@agent-atexit/opencode" && manifest.name !== "@agent-atexit/dsh") throw new Error(`${path} has an unexpected name`);
}
const codexMcp = await readJson("plugins/atexit/.mcp.json");
const claudeMcp = await readJson("plugins/atexit/.mcp.claude.json");
if (!("mcpServers" in codexMcp)) throw new Error("Codex MCP config must contain an mcpServers map");
if (!("mcpServers" in claudeMcp)) throw new Error("Claude MCP config must contain an mcpServers map");
const hooks = await readJson("plugins/atexit/hooks/hooks.json") as { hooks?: Record<string, unknown> };
if (!hooks.hooks?.PostToolUse || !hooks.hooks?.SessionEnd) throw new Error("portable hooks must bind registrations and close sessions");
await Promise.all(["plugins/atexit/dist/mcp.mjs", "plugins/atexit/dist/hook.mjs", "plugins/atexit/dist/worker.mjs", "adapters/opencode/dist/server.js", "adapters/dsh/dist/index.js"].map((path) => access(resolve(root, path))));
