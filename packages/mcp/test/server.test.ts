import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { cleanupInstruction, codexCleanupInstruction, hermesCleanupInstruction, claudeCleanupInstruction } from "../src/instructions";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("agent-atexit MCP server", () => {
  test("selects host guidance through shipped configs without changing shared tool contracts", async () => {
    const pluginRoot = resolve(import.meta.dirname, "../../../plugins/atexit");
    const snapshots = [];
    for (const [host, instructions] of [["default", cleanupInstruction], ["codex", codexCleanupInstruction], ["claude", claudeCleanupInstruction], ["hermes", hermesCleanupInstruction]]) {
      let config: { command: string; args: string[]; cwd?: string };
      if (host === "default") {
        config = { command: "node", args: [join(pluginRoot, "dist/mcp.mjs")] };
      } else if (host === "hermes") {
        const hermes = Bun.YAML.parse(await readFile(resolve(pluginRoot, "../../adapters/hermes/config.yaml"), "utf8")) as { mcp_servers: { atexit: typeof config } };
        config = hermes.mcp_servers.atexit;
      } else {
        const manifest = JSON.parse(await readFile(join(pluginRoot, `.${host}-plugin/plugin.json`), "utf8"));
        config = JSON.parse(await readFile(resolve(pluginRoot, manifest.mcpServers), "utf8")).mcpServers.atexit;
      }
      const root = await mkdtemp(join(tmpdir(), "agent-atexit-guidance-")); roots.push(root);
      const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
      const args = (config.args as string[]).map((arg) => arg.replace("${CLAUDE_PLUGIN_ROOT}", pluginRoot).replace("/absolute/path/to/agent-atexit", resolve(pluginRoot, "../..")));
      const transport = new StdioClientTransport({ command: config.command, args, cwd: resolve(pluginRoot, config.cwd ?? "."), env: { ...env, AGENT_ATEXIT_STATE_DIR: root } });
      const client = new Client({ name: "agent-atexit-guidance-test", version: "0.1.0" });
      try {
        await client.connect(transport);
        expect(client.getInstructions()).toBe(instructions);
        snapshots.push((await client.listTools()).tools);
      } finally {
        await client.close();
      }
    }
    const [defaultTools, codexTools, claudeTools, hermesTools] = snapshots;
    expect(hermesTools).toEqual(defaultTools);
    expect(codexTools!.map(({ description, ...contract }) => contract)).toEqual(claudeTools!.map(({ description, ...contract }) => contract));
    expect(codexTools!.filter((tool, i) => tool.description !== claudeTools![i]!.description).map(({ name }) => name).toSorted()).toEqual(["atexit_cancel", "atexit_register"]);
  });

  test("registers, lists, and cancels by capability ID", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-atexit-mcp-"));
    roots.push(root);
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    const transport = new StdioClientTransport({ args: [resolve(import.meta.dirname, "../../../plugins/atexit/dist/mcp.mjs")], command: "node", env: { ...env, AGENT_ATEXIT_STATE_DIR: root } });
    const client = new Client({ name: "agent-atexit-test", version: "0.1.0" });
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).toSorted()).toEqual(["atexit_cancel", "atexit_list", "atexit_register"]);
      const registered = await client.callTool({ arguments: { argv: ["echo", "hello"] }, name: "atexit_register" });
      const id = (registered.structuredContent as { registration_id?: string } | undefined)?.registration_id;
      expect(id).toBeString();
      const listed = await client.callTool({ arguments: { registration_ids: [id] }, name: "atexit_list" });
      expect((listed.structuredContent as { registrations: unknown[] }).registrations).toHaveLength(1);
      const cancelled = await client.callTool({ arguments: { registration_id: id }, name: "atexit_cancel" });
      expect(cancelled.structuredContent).toMatchObject({ cancelled: true, registration_id: id, state: "cancelled" });
    } finally {
      await client.close();
    }
  });
});
