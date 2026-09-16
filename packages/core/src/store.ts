import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { sessionKey } from "./paths.ts";
import type { BindResult, CancelResult, RegisterInput, RegistrationRecord, RunRecord, SessionBinding } from "./types.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const LOCK_STALE_MS = 10_000;

function validateRegisterInput(input: RegisterInput): void {
  if (!Array.isArray(input.argv) || input.argv.length === 0 || input.argv[0].length === 0 || input.argv.some((part) => typeof part !== "string")) throw new Error("argv must start with a non-empty executable string");
  if (input.cwd !== undefined && !input.cwd.startsWith("/")) throw new Error("cwd must be an absolute path");
  if (input.key !== undefined && (input.key.length === 0 || input.key.length > 128)) throw new Error("key must contain 1-128 characters");
  if (input.timeoutMs !== undefined && (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 100 || input.timeoutMs > MAX_TIMEOUT_MS)) throw new Error(`timeoutMs must be an integer from 100 to ${MAX_TIMEOUT_MS}`);
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : undefined;
}

export class ActionStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  async init(): Promise<void> {
    await Promise.all(["records", "runs", "locks", "sessions", "logs"].map((directory) => mkdir(join(this.root, directory), { recursive: true, mode: 0o700 })));
    await chmod(this.root, 0o700);
  }

  async register(input: RegisterInput): Promise<RegistrationRecord> {
    validateRegisterInput(input);
    await this.init();
    const registration: RegistrationRecord = {
      argv: [...input.argv] as [string, ...string[]],
      createdAt: new Date().toISOString(),
      id: randomUUID(),
      state: "provisional",
      timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(input.key === undefined ? {} : { key: input.key }),
    };
    await this.writeRegistration(registration);
    return registration;
  }

  async bind(id: string, binding: SessionBinding): Promise<BindResult> {
    await this.init();
    return this.withRecordLock(id, async () => {
      const current = await this.get(id);
      if (current.state !== "provisional") return { registration: current };
      const key = sessionKey(binding.host, binding.sessionId);
      return this.withSessionLock(key, async () => {
        if (current.key) await this.cancelReplaced(current, key);
        const registration: RegistrationRecord = { ...current, boundAt: new Date().toISOString(), cwd: current.cwd ?? binding.cwd, host: binding.host, sessionKey: key, state: "pending" };
        await this.writeRegistration(registration);
        if (!(await this.isSessionClosed(key))) return { registration };
        const lateRun = await this.claimPendingLocked(key, binding.host);
        return { registration: await this.get(id), ...(lateRun === undefined ? {} : { lateRun }) };
      });
    });
  }

  async closeAndClaim(binding: SessionBinding): Promise<RunRecord | undefined> {
    await this.init();
    const key = sessionKey(binding.host, binding.sessionId);
    return this.withSessionLock(key, async () => {
      await atomicWrite(this.sessionPath(key), { closedAt: new Date().toISOString(), cwd: binding.cwd, host: binding.host, sessionKey: key });
      return this.claimPendingLocked(key, binding.host);
    });
  }

  async cancel(id: string): Promise<CancelResult> {
    await this.init();
    return this.withRecordLock(id, async () => {
      let registration = await this.get(id);
      if (registration.state !== "provisional" && registration.state !== "pending") return { cancelled: false, registration };
      if (registration.sessionKey) {
        registration = await this.withSessionLock(registration.sessionKey, async () => {
          const latest = await this.get(id);
          if (latest.state !== "pending") return latest;
          const cancelled: RegistrationRecord = { ...latest, cancelledAt: new Date().toISOString(), state: "cancelled" };
          await this.writeRegistration(cancelled);
          return cancelled;
        });
      } else {
        registration = { ...registration, cancelledAt: new Date().toISOString(), state: "cancelled" };
        await this.writeRegistration(registration);
      }
      return { cancelled: registration.state === "cancelled", registration };
    });
  }

  async get(id: string): Promise<RegistrationRecord> {
    try {
      return await readJson<RegistrationRecord>(this.recordPath(id));
    } catch (error) {
      if (errorCode(error) === "ENOENT") throw new Error(`unknown registration: ${id}`);
      throw error;
    }
  }

  async list(ids?: readonly string[]): Promise<RegistrationRecord[]> {
    await this.init();
    const selected = ids ?? (await readdir(join(this.root, "records"))).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5));
    const registrations = await Promise.all(selected.map(async (id) => this.get(id).catch(() => undefined)));
    return registrations.filter((registration): registration is RegistrationRecord => registration !== undefined).toSorted((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async getRun(id: string): Promise<RunRecord> {
    return readJson<RunRecord>(this.runPath(id));
  }

  async writeRun(run: RunRecord): Promise<void> {
    await atomicWrite(this.runPath(run.id), run);
  }

  async writeRegistration(registration: RegistrationRecord): Promise<void> {
    await atomicWrite(this.recordPath(registration.id), registration);
  }

  async acquireRun(id: string): Promise<Awaited<ReturnType<typeof open>> | undefined> {
    this.runPath(id);
    try {
      return await open(join(this.root, "runs", `${id}.lock`), "wx", 0o600);
    } catch (error) {
      if (errorCode(error) === "EEXIST") return undefined;
      throw error;
    }
  }

  logPath(id: string): string {
    return join(this.root, "logs", `${id}.log`);
  }

  private async cancelReplaced(current: RegistrationRecord, key: string): Promise<void> {
    const registrations = await this.list();
    for (const registration of registrations) {
      if (registration.id === current.id || registration.sessionKey !== key || registration.key !== current.key || registration.state !== "pending") continue;
      await this.writeRegistration({ ...registration, cancelledAt: new Date().toISOString(), state: "cancelled" });
    }
  }

  private async claimPendingLocked(key: string, host: string): Promise<RunRecord | undefined> {
    const pending = (await this.list()).filter((registration) => registration.sessionKey === key && registration.state === "pending").toSorted((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
    if (pending.length === 0) return undefined;
    const now = new Date().toISOString();
    const run: RunRecord = { actionIds: pending.map((registration) => registration.id), createdAt: now, host, id: randomUUID(), sessionKey: key, state: "claimed" };
    for (const registration of pending) await this.writeRegistration({ ...registration, claimedAt: now, runId: run.id, state: "claimed" });
    await this.writeRun(run);
    return run;
  }

  private async isSessionClosed(key: string): Promise<boolean> {
    try {
      await stat(this.sessionPath(key));
      return true;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return false;
      throw error;
    }
  }

  private async withRecordLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    // IDs also name lock paths; reject traversal before stale-lock recovery can remove a directory.
    this.recordPath(id);
    return this.withLock(`record-${id}`, operation);
  }

  private async withSessionLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    return this.withLock(`session-${key}`, operation);
  }

  private async withLock<T>(name: string, operation: () => Promise<T>): Promise<T> {
    const path = join(this.root, "locks", name);
    const startedAt = Date.now();
    while (true) {
      try {
        await mkdir(path, { mode: 0o700 });
        break;
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
        const info = await stat(path).catch(() => undefined);
        if (info && Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          await rm(path, { force: true, recursive: true });
          continue;
        }
        if (Date.now() - startedAt > 2_000) throw new Error(`timed out waiting for lock: ${name}`);
        await delay(10);
      }
    }
    try {
      return await operation();
    } finally {
      await rm(path, { force: true, recursive: true });
    }
  }

  private recordPath(id: string): string {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error(`invalid registration id: ${id}`);
    return join(this.root, "records", `${id}.json`);
  }

  private runPath(id: string): string {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error(`invalid run id: ${id}`);
    return join(this.root, "runs", `${id}.json`);
  }

  private sessionPath(key: string): string {
    return join(this.root, "sessions", `${key}.json`);
  }
}
