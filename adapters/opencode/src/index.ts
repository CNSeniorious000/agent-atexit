import { setTimeout as delay } from "node:timers/promises";
import type { Plugin } from "@opencode/plugin";
import { tool } from "@opencode-ai/plugin";
import legacy from "./legacy.ts";

// Both native versions resolve /server; the shared export exposes their distinct lifecycle APIs.
export default {
  id: "agent-atexit.opencode",
  async setup(ctx) {
    const hooks = await legacy.server({ directory: ctx.location.directory } as never);
    await ctx.tool.transform((editor) => {
      for (const [name, definition] of Object.entries(hooks.tool!)) editor.add({
        name, options: { codemode: false }, description: definition.description, input: tool.schema.object(definition.args),
        async execute(input, context) {
          const content = await definition.execute(input, {
            sessionID: context.sessionID, messageID: context.messageID, agent: context.agent, abort: context.signal,
            directory: ctx.location.directory, worktree: ctx.location.project.directory, metadata: () => {},
            ask: async (request) => ctx.permission.assert({ sessionID: context.sessionID, agent: context.agent, action: request.permission, resources: request.patterns, save: request.always, metadata: request.metadata }),
          });
          return { content: typeof content === "string" ? content : content.output };
        },
      });
    });
    await ctx.session.hook("context", async (event) => {
      const output = { system: [] as string[] };
      await hooks["experimental.chat.system.transform"]!({ model: {} as never }, output);
      event.system.push(...output.system.map(text => ({ type: "text" as const, text })));
    });
    const abort = new AbortController();
    const events = (async () => {
      while (!abort.signal.aborted) {
        try {
          for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
            if (event.type !== "session.deleted") continue;
            try { await hooks.event!({ event: { type: "session.deleted", properties: { info: { id: event.data.sessionID } } } as never }); }
            catch (error) { console.error("agent-atexit session cleanup failed", error); }
          }
        } catch (error) { if (!abort.signal.aborted) console.error("agent-atexit event subscription failed", error); }
        // Back off on failed or prematurely ended subscriptions; disposal interrupts the wait.
        if (!abort.signal.aborted) await delay(250, undefined, { signal: abort.signal }).catch(error => { if (!abort.signal.aborted) throw error; });
      }
    })();
    // Observe the subscription immediately; only intentional shutdown suppresses an error.
    const observed = events.catch(error => { if (!abort.signal.aborted) console.error("agent-atexit event subscription failed", error); });
    return async () => { abort.abort(); await observed; await hooks.dispose!(); };
  },
} satisfies Plugin.Plugin;
