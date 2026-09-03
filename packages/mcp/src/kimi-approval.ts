import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const APPROVAL_TTL_MS = 5_000;
const KIMI_REGISTER_TOOL = "mcp__plugin-atexit_atexit__atexit_register";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface KimiApprovalProof {
  approvalId: string;
  createdAt: string;
  cwd: string;
  inputHash: string;
  sessionId: string;
  toolCallId: string;
}

export interface KimiPermissionResult {
  cwd?: string;
  decision?: string;
  hook_event_name?: string;
  session_id?: string;
  tool_call_id?: string;
  tool_input?: unknown;
  tool_name?: string;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).toSorted(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

function inputHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function approvalPath(root: string, approvalId: string, state: "pending" | "used"): string {
  if (!UUID.test(approvalId)) throw new Error("Kimi approval_id must be a UUID");
  return join(root, "approvals", `${approvalId}.${state}.json`);
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

async function withApprovalLock<T>(root: string, approvalId: string, operation: () => Promise<T>): Promise<T> {
  const lock = join(root, "locks", `approval-${approvalId}`);
  await mkdir(dirname(lock), { recursive: true, mode: 0o700 });
  const startedAt = Date.now();
  while (true) {
    try {
      await mkdir(lock, { mode: 0o700 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() - startedAt > 2_000) throw new Error("timed out waiting for Kimi approval lock");
      await delay(10);
    }
  }
  try {
    return await operation();
  } finally {
    await rm(lock, { force: true, recursive: true });
  }
}

export async function recordKimiApproval(root: string, input: KimiPermissionResult): Promise<boolean> {
  if (input.hook_event_name !== "PermissionResult" || input.tool_name !== KIMI_REGISTER_TOOL || input.decision !== "approved") return false;
  if (!input.cwd || !input.session_id || !input.tool_call_id || !input.tool_input || typeof input.tool_input !== "object") return false;
  const approvalId = (input.tool_input as { approval_id?: unknown }).approval_id;
  if (typeof approvalId !== "string" || !UUID.test(approvalId)) return false;
  const proof: KimiApprovalProof = { approvalId, createdAt: new Date().toISOString(), cwd: input.cwd, inputHash: inputHash(input.tool_input), sessionId: input.session_id, toolCallId: input.tool_call_id };
  return withApprovalLock(root, approvalId, async () => {
    if (await stat(approvalPath(root, approvalId, "used")).then(() => true, () => false)) return false;
    if (await stat(approvalPath(root, approvalId, "pending")).then(() => true, () => false)) return false;
    await atomicWrite(approvalPath(root, approvalId, "pending"), proof);
    return true;
  });
}

export async function consumeKimiApproval(root: string, toolInput: unknown): Promise<KimiApprovalProof> {
  const approvalId = toolInput && typeof toolInput === "object" ? (toolInput as { approval_id?: unknown }).approval_id : undefined;
  if (typeof approvalId !== "string" || !UUID.test(approvalId)) throw new Error("Kimi requires a fresh UUID approval_id for every atexit registration");
  const expectedHash = inputHash(toolInput);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const proof = await withApprovalLock(root, approvalId, async () => {
      const pending = approvalPath(root, approvalId, "pending");
      const used = approvalPath(root, approvalId, "used");
      if (await stat(used).then(() => true, () => false)) throw new Error("Kimi approval_id was already consumed");
      let value: KimiApprovalProof;
      try {
        value = JSON.parse(await readFile(pending, "utf8")) as KimiApprovalProof;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
      if (Date.now() - Date.parse(value.createdAt) > APPROVAL_TTL_MS || value.inputHash !== expectedHash) {
        await rename(pending, used);
        throw new Error("Kimi approval proof is stale or does not match this registration");
      }
      await rename(pending, used);
      return value;
    });
    if (proof) return proof;
    await delay(50);
  }
  throw new Error("Kimi registration requires a fresh interactive approval; automatic or cached approval is rejected");
}
