import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ActionStore, resolveStateRoot } from "@agent-atexit/core";
import { z } from "zod";

const stateRoot = resolveStateRoot();
const store = new ActionStore(stateRoot);
const server = new McpServer({ name: "agent-atexit", version: "0.1.0" }, { instructions: "Register exact cleanup before starting any CLI-managed session or long-lived process that could outlive this agent session. Registration is deferred, so keep it while the resource remains available for follow-up. If creation assigns the cleanup target, register immediately afterward. Cancel only after normal cleanup." });
const registrationId = z.string().uuid().describe("Registration ID returned by atexit_register.");

server.registerTool("atexit_register", {
  annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true, readOnlyHint: false },
  description: "Before starting any CLI-managed session or long-lived process that could outlive this agent session—such as a browser session, daemon, or dev server—register its exact cleanup argv. Registration is deferred, so keep it while the resource remains available for follow-up. If creation assigns the cleanup target, register immediately afterward. Cancel only after normal cleanup. argv executes directly, without a shell.",
  inputSchema: {
    argv: z.array(z.string()).min(1).describe("Executable followed by literal arguments. Shell syntax such as pipes and redirects is not interpreted."),
    cwd: z.string().optional().describe("Absolute working directory. Defaults to the session cwd supplied by the lifecycle hook."),
    key: z.string().min(1).max(128).optional().describe("Optional replacement key. A newer pending command with the same key supersedes the older one in this session."),
    timeout_ms: z.number().int().min(100).max(86_400_000).optional().describe("Command timeout in milliseconds. Defaults to 30000."),
  },
  _meta: { "anthropic/alwaysLoad": true },
}, async ({ argv, cwd, key, timeout_ms }) => {
  if (!argv[0]) throw new Error("Executable must not be empty.");
  const literalArgv = argv as [string, ...string[]];
  const registration = await store.register({ argv: literalArgv, ...(cwd === undefined ? {} : { cwd }), ...(key === undefined ? {} : { key }), ...(timeout_ms === undefined ? {} : { timeoutMs: timeout_ms }) });
  const result = { argv: registration.argv, registration_id: registration.id, state: registration.state };
  return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
});

server.registerTool("atexit_cancel", {
  annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false, readOnlyHint: false },
  description: "Cancel a pending atexit registration by its unguessable registration ID. Claimed or running commands cannot be cancelled.",
  inputSchema: { registration_id: registrationId },
  _meta: { "anthropic/alwaysLoad": true },
}, async ({ registration_id }) => {
  const result = await store.cancel(registration_id);
  const value = { cancelled: result.cancelled, registration_id, state: result.registration.state };
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
});

server.registerTool("atexit_list", {
  annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false, readOnlyHint: true },
  description: "Inspect atexit registrations by IDs previously returned to this session. Requiring IDs prevents one session from enumerating another session's commands.",
  inputSchema: { registration_ids: z.array(registrationId).min(1).max(100) },
  _meta: { "anthropic/alwaysLoad": true },
}, async ({ registration_ids }) => {
  const registrations = await store.list(registration_ids);
  const value = { registrations: registrations.map(({ id, argv, cwd, key, state, timeoutMs }) => ({ argv, cwd: cwd ?? null, key: key ?? null, registration_id: id, state, timeout_ms: timeoutMs })) };
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
});

await server.connect(new StdioServerTransport());
