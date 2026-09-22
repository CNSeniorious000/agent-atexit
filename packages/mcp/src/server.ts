import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ActionStore, resolveStateRoot } from "@agent-atexit/core";
import { z } from "zod";
import { cleanupInstruction, codexCleanupInstruction, hermesCleanupInstruction, claudeCleanupInstruction } from "./instructions";

const codex = process.argv.includes("--codex"), hermes = process.argv.includes("--hermes");
const claude = !codex && !hermes && process.argv.includes("--claude");
const stateRoot = resolveStateRoot();
const store = new ActionStore(stateRoot);
const server = new McpServer({ name: "agent-atexit", version: "0.1.0" }, { instructions: codex ? codexCleanupInstruction : hermes ? hermesCleanupInstruction : claude ? claudeCleanupInstruction : cleanupInstruction });
const registrationId = z.string().uuid().describe("Registration ID returned by atexit_register.");

server.registerTool("atexit_register", {
  annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true, readOnlyHint: false },
  description: claude ? "Register cleanup argv for an acquired temporary process or CLI session in the first response after its target is known. Batch with ready resource use, inspection, or other substantive work; planning updates do not count. Preregistration needs a known target and absence-tolerant cleanup. argv runs without a shell." : "Register scoped cleanup argv for a temporary process or CLI session kept live across calls. Cover all newly acquired resources in the first response after their real cleanup targets are known, alongside use, inspection, or other independent task work. Use parallel calls or one orchestration invocation to avoid a separate bookkeeping turn. Register before creation only if cleanup tolerates the known target's absence. " + (codex ? "Use an executable verified in the cleanup environment; argv runs directly, without a shell." : "argv executes directly, without a shell."),
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
  description: codex
    ? "Remove a fallback without executing it. Cancel only after verifying release of the exact resource identified by this registration's argv; a related resource's state or a stop acknowledgment is insufficient. Failed checks are inconclusive. Sequence cleanup, verification and cancellation within one orchestration when possible. Combine eligible cancellation with ready independent work; standalone is fine when none remains. Creation confirmed to have left no resource also permits cancellation. Claimed or running commands cannot be cancelled."
    : claude ? "Cancel without running the fallback after returned proof of its target\u2019s release. Successful cleanup with a release guarantee suffices; a signal or request acknowledgment alone does not. Error-masked checks do not prove release. Use the first eligible batch with independent work, never alongside cleanup or verification it depends on. Within one orchestration, await and check the proof. Confirmed noncreation qualifies. Claimed or running commands cannot be cancelled."
    : "Remove a fallback without executing it. Confirm resource release before cancelling; a stop acknowledgment alone is insufficient. Never parallelize cancellation with its cleanup or the check establishing release. Then combine cancellation with independent remaining work, including cleanup of other resources. A separate call is appropriate when none remains. Creation confirmed to have left no resource also permits cancellation. Claimed or running commands cannot be cancelled.",
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
