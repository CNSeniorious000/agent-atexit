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
const codexMcp = await readJson("plugins/atexit/.mcp.codex.json");
const claudeMcp = await readJson("plugins/atexit/.mcp.claude.json");
if (!("mcpServers" in codexMcp)) throw new Error("Codex MCP config must contain an mcpServers map");
if (!("mcpServers" in claudeMcp)) throw new Error("Claude MCP config must contain an mcpServers map");
const hooks = await readJson("plugins/atexit/hooks/hooks.json") as { hooks?: Record<string, unknown> };
if (!hooks.hooks?.SessionStart || !hooks.hooks?.PostToolUse || !hooks.hooks?.SessionEnd) throw new Error("portable hooks must open sessions, bind registrations, and close sessions");
const kimi = await readJson("adapters/kimi-code/kimi.plugin.json");
if (typeof kimi.systemPrompt !== "string" || !/register.*fallback cleanup/is.test(kimi.systemPrompt) || !/cleanup succeeds.*cancel/is.test(kimi.systemPrompt)) throw new Error("Kimi system prompt must cover fallback registration and cancellation after successful cleanup");
const hermes = Bun.YAML.parse(await readFile(resolve(root, "adapters/hermes/config.yaml"), "utf8")) as { skills?: { auto_load?: string[] }; plugins?: { hook_callback_timeout?: number }; mcp_servers?: { atexit?: { command?: string; args?: string[]; env?: { AGENT_ATEXIT_STATE_DIR?: string } } }; hooks?: Record<string, { command?: string; matcher?: string; timeout?: number }[]> };
if (!hermes.skills?.auto_load?.includes("defer-cleanup")) throw new Error("Hermes config must load the cleanup skill through native skills.auto_load");
if (!hermes.mcp_servers?.atexit?.env?.AGENT_ATEXIT_STATE_DIR || !hermes.hooks?.post_tool_call?.length || !hermes.hooks?.on_session_finalize?.length) throw new Error("Hermes config must provide shared state and registration/finalization hooks");
const hermesMcp = hermes.mcp_servers.atexit, hermesState = hermesMcp.env!.AGENT_ATEXIT_STATE_DIR!;
if (hermesMcp.command !== "node" || hermesMcp.args?.length !== 2 || !hermesMcp.args[0]?.endsWith("/mcp.mjs") || hermesMcp.args[1] !== "--hermes") throw new Error("Hermes MCP config must launch the portable server with Hermes guidance");
// Validate the shipped template as one unit: a hook using another state directory silently loses registrations.
const hermesHookCommand = `env "AGENT_ATEXIT_STATE_DIR=${hermesState}" node "${hermesMcp.args[0].replace(/mcp\.mjs$/, "hook.mjs")}"`;
for (const event of ["post_tool_call", "on_session_finalize"]) for (const hook of hermes.hooks[event]!) {
  if (hook.command !== hermesHookCommand || hook.timeout !== 3) throw new Error(`Hermes ${event} must run the portable hook with shared state and a 3-second budget`);
  if (hook.matcher !== (event === "post_tool_call" ? "^mcp__atexit__atexit_register$" : undefined)) throw new Error(`Hermes ${event} has an unexpected matcher`);
}
if (hermes.plugins?.hook_callback_timeout !== 0) throw new Error("Hermes must preserve overlapping lifecycle callbacks");
await Promise.all(["plugins/atexit/dist/mcp.mjs", "plugins/atexit/dist/hook.mjs", "plugins/atexit/dist/worker.mjs", "adapters/opencode/dist/server.js", "adapters/dsh/dist/index.js"].map((path) => access(resolve(root, path))));
