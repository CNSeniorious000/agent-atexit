import { createWriteStream } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { finished } from "node:stream/promises";
import { ActionStore } from "./store.ts";
import type { ExecuteRunResult, RegistrationRecord } from "./types.ts";

async function executeRegistration(store: ActionStore, registration: RegistrationRecord): Promise<RegistrationRecord> {
  const startedAt = new Date().toISOString();
  let running: RegistrationRecord = { ...registration, startedAt, state: "running" };
  await store.writeRegistration(running);
  const log = createWriteStream(store.logPath(registration.id), { flags: "a", mode: 0o600 });
  const logClosed = finished(log).then(() => undefined, (error: unknown) => error);
  try {
    await once(log, "open");
    log.write(`[${startedAt}] ${JSON.stringify(registration.argv)}\n`);
    const child = spawn(registration.argv[0], registration.argv.slice(1), { cwd: registration.cwd, env: process.env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    void logClosed.then((error) => {
      if (error === undefined) return;
      // 日志失败会解除 pipe；继续排空输出，避免清理命令因背压卡住。
      child.stdout.unpipe(log).resume();
      child.stderr.unpipe(log).resume();
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      void delay(1_000).then(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      });
    }, registration.timeoutMs);
    const [exitCode, signal] = (await once(child, "exit").finally(() => clearTimeout(timer))) as [number | null, NodeJS.Signals | null];
    const completedAt = new Date().toISOString();
    const succeeded = !timedOut && exitCode === 0;
    running = { ...running, completedAt, exitCode, state: succeeded ? "succeeded" : "failed", ...(succeeded ? {} : { error: timedOut ? `timed out after ${registration.timeoutMs}ms` : signal ? `terminated by ${signal}` : `exited with code ${String(exitCode)}` }) };
  } catch (error) {
    running = { ...running, completedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error), state: "failed" };
  } finally {
    log.end();
    const error = await logClosed;
    if (error !== undefined) running = { ...running, error: error instanceof Error ? error.message : String(error), state: "failed" };
  }
  await store.writeRegistration(running);
  return running;
}

export async function executeRun(root: string, runId: string): Promise<ExecuteRunResult> {
  const store = new ActionStore(root);
  await store.init();
  const lock = await store.acquireRun(runId);
  const run = await store.getRun(runId);
  if (!lock) return { alreadyStarted: true, executed: [], run };
  await lock.close();
  const running = { ...run, startedAt: new Date().toISOString(), state: "running" as const };
  await store.writeRun(running);
  const executed: string[] = [];
  for (const actionId of running.actionIds) {
    const registration = await store.get(actionId);
    if (registration.state !== "claimed" || registration.runId !== runId) continue;
    await executeRegistration(store, registration);
    executed.push(actionId);
  }
  const completed = { ...running, completedAt: new Date().toISOString(), state: "completed" as const };
  await store.writeRun(completed);
  return { alreadyStarted: false, executed, run: completed };
}
