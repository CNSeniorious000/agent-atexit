import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ActionStore } from "../src/store.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

for (const failure of ["open", "write"]) {
  test(`worker records log ${failure} failures and continues with the next cleanup`, async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-atexit-log-")); roots.push(root);
    const store = new ActionStore(root), binding = { cwd: root, host: "test", sessionId: "log-error" }, output = join(root, "healthy.txt");
    const broken = await store.register({ argv: ["node", "-e", "for (const stream of [process.stdout, process.stderr]) stream.write(Buffer.alloc(4 * 1024 * 1024, 'x'))"], timeoutMs: 1_000 });
    const healthy = await store.register({ argv: ["node", "-e", `require('node:fs').writeFileSync(${JSON.stringify(output)}, 'done')`] });
    await store.bind(broken.id, binding); await store.bind(healthy.id, binding);
    const run = (await store.closeAndClaim(binding))!;
    await store.writeRun({ ...run, actionIds: [broken.id, healthy.id] });
    if (failure === "open") await mkdir(store.logPath(broken.id));
    const worker = pathToFileURL(resolve(import.meta.dirname, "../../../plugins/atexit/dist/worker.mjs")).href;
    const injection = failure === "write" ? `
      const fs = require('node:fs'), original = fs.createWriteStream;
      fs.createWriteStream = (path, options) => original(path, path === ${JSON.stringify(store.logPath(broken.id))} ? { ...options, fs: {
        open: fs.open, close: fs.close,
        write(fd, buffer, offset, length, position, callback) { callback(new Error('log write fixture')); }
      } } : options);
      require('node:module').syncBuiltinESMExports();
    ` : "";
    const code = `${injection}\nprocess.argv = [process.execPath, 'worker', '--state-dir', ${JSON.stringify(root)}, '--run-id', ${JSON.stringify(run.id)}]; import(${JSON.stringify(worker)}).catch(error => { console.error(error); process.exitCode = 1; });`;
    const child = spawn("node", ["-e", code], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 3_000);
    try {
      const [code, signal] = await once(child, "close");
      expect({ code, signal, stderr }).toEqual({ code: 0, signal: null, stderr: "" });
      expect(await store.get(broken.id)).toMatchObject({ state: "failed", error: expect.stringContaining(failure === "open" ? "EISDIR" : "log write fixture") });
      if (failure === "write") expect((await store.get(broken.id)).exitCode).toBe(0);
      expect((await store.get(healthy.id)).state).toBe("succeeded");
      expect((await store.getRun(run.id)).state).toBe("completed");
      expect(await readFile(output, "utf8")).toBe("done");
    } finally { clearTimeout(timer); }
  });
}
