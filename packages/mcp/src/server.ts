import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ActionStore, resolveStateRoot } from "@agent-atexit/core";
import { z } from "zod";

const stateRoot = resolveStateRoot();
const store = new ActionStore(stateRoot);
const server = new McpServer({ name: "agent-atexit", version: "0.1.0" }, { instructions: "For a temporary browser session or background process left running across tool calls, register its exact cleanup argv with atexit_register once the real target is known. Never use placeholders or guessed handles. Register before creation only if cleanup safely tolerates the known target's absence; if creation assigns the target, register in the first response after receiving it. Use parallel tool calls for ready registry updates and independent work in the same response. Avoid a registry-only response when such work is ready, without delaying registration to find a batch partner. After successful normal cleanup or confirmation that creation left no resource, cancel its registration in parallel with independent remaining work, including cleanup of other resources. Cancellation removes the fallback without executing cleanup, so never run it in parallel with its own cleanup. With programmable orchestration, await and check cleanup success, then cancel in the same invocation. If nothing independent remains, call alone; do not invent work or split efficient cleanup to fill a batch." });
const registrationId = z.string().uuid().describe("Registration ID returned by atexit_register.");

server.registerTool("atexit_register", {
  annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true, readOnlyHint: false },
  description: "Use parallel tool calls to register alongside independent work in the same response. Avoid a registration-only response when other work is ready, without delaying registration to find a batch partner. Register scoped cleanup argv for temporary browser sessions or background processes left running across tool calls. Use a real target, never a placeholder or guessed handle. Register before creation only when the target is known and cleanup safely tolerates its absence; if creation assigns the target, register in the first response after receiving it. Keep the fallback while the resource remains available. argv executes directly, without a shell.",
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
  description: "After successful manual cleanup or confirmation that creation left no resource, cancel its fallback in parallel with independent remaining work, including cleanup of other resources. This only removes the registration; it does not execute cleanup. Never cancel in parallel with its own cleanup, since failure would leave no fallback. Use a separate call only if no independent work remains. Claimed or running commands cannot be cancelled.",
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
