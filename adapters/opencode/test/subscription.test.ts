import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { Host } from "@opencode/plugin/host";
import legacy from "../src/legacy.ts";
import native from "../src/index.ts";

test("official native v2 loader resolves the built directory through server.js", async () => {
  const entry = Host.resolve({ directory: resolve(import.meta.dirname, "../dist") });
  expect(entry.server).toEndWith("/server.js");
  const plugin = (await Host.load(entry.server!) as { default: any }).default;
  expect(typeof plugin.server).toBe("function"); expect(typeof plugin.setup).toBe("function");
});

test("failed handlers and subscriptions do not prevent later deletions or disposal", async () => {
  const original = legacy.server, seen: string[] = []; let attempts = 0, disposed = false;
  legacy.server = async () => ({ tool: {}, event: async ({ event }: any) => { seen.push(event.properties.info.id); if (seen.length === 1) throw new Error("handler fixture"); }, dispose: async () => { disposed = true; } });
  try {
    const cleanup = await native.setup({
      location: { directory: "/fixture" }, tool: { transform: async () => {} }, session: { hook: async () => {} },
      event: { async *subscribe({ signal }: { signal: AbortSignal }) {
        attempts++;
        if (attempts === 1) { yield { type: "session.deleted", data: { sessionID: "first" } }; yield { type: "session.deleted", data: { sessionID: "second" } }; throw new Error("stream fixture"); }
        yield { type: "session.deleted", data: { sessionID: "third" } };
        await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
      } },
    } as never);
    for (let i = 0; i < 100 && seen.length < 3; i++) await Bun.sleep(10);
    await cleanup();
    expect(seen).toEqual(["first", "second", "third"]); expect(attempts).toBe(2); expect(disposed).toBe(true);
  } finally { legacy.server = original; }
});
