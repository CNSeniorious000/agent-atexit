import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ActionStore } from "@agent-atexit/core";
import { recordKimiApproval } from "../src/kimi-approval.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("agent-atexit MCP server", () => {
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

  test("requires and consumes an interactive Kimi approval proof", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-atexit-mcp-"));
    roots.push(root);
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    const transport = new StdioClientTransport({ args: [resolve(import.meta.dirname, "../../../plugins/atexit/dist/mcp.mjs")], command: "node", env: { ...env, AGENT_ATEXIT_STATE_DIR: root, KIMI_CODE_HOME: root } });
    const client = new Client({ name: "agent-atexit-test", version: "0.1.0" });
    await client.connect(transport);
    try {
      const approval_id = randomUUID();
      const tool_input = { approval_id, argv: ["echo", "approved"] };
      await recordKimiApproval(root, { cwd: root, decision: "approved", hook_event_name: "PermissionResult", session_id: "kimi-session", tool_call_id: "call-1", tool_input, tool_name: "mcp__plugin-atexit_atexit__atexit_register" });
      const registered = await client.callTool({ arguments: tool_input, name: "atexit_register" });
      expect(registered.isError).not.toBe(true);
      expect(registered.structuredContent).toMatchObject({ state: "pending" });
      const id = (registered.structuredContent as { registration_id: string }).registration_id;
      expect(await new ActionStore(root).get(id)).toMatchObject({ host: "kimi-code", state: "pending" });
      const replayed = await client.callTool({ arguments: tool_input, name: "atexit_register" });
      expect(replayed.isError).toBe(true);
      expect(await new ActionStore(root).list()).toHaveLength(1);
    } finally {
      await client.close();
    }
  });
});
