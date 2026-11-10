import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ActionStore } from "../src/store";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

test("worker exits after a spawn failure without waiting for the command timeout", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-atexit-runner-")); roots.push(root);
  const store = new ActionStore(root), binding = { cwd: root, host: "test", sessionId: "spawn-error" };
  const registration = await store.register({ argv: [join(root, "missing-command")], timeoutMs: 60_000 });
  await store.bind(registration.id, binding);
  const run = await store.closeAndClaim(binding);
  const child = spawn("node", [resolve(import.meta.dirname, "../../../plugins/atexit/dist/worker.mjs"), "--state-dir", root, "--run-id", run!.id], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
  try {
    const [code, signal] = await once(child, "close");
    expect({ code, signal, stderr }).toEqual({ code: 0, signal: null, stderr: "" });
    expect(await store.get(registration.id)).toMatchObject({ state: "failed", error: expect.stringContaining("ENOENT") });
    expect((await store.getRun(run!.id)).state).toBe("completed");
  } finally {
    clearTimeout(timer);
  }
});
