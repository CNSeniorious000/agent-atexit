import type { Plugin } from "@opencode/plugin";
import { tool } from "@opencode-ai/plugin";
import legacy from "./legacy.ts";

// Native v2 loads directory/index.mjs and uses setup, not v1's /server export.
export default {
  id: "agent-atexit.opencode",
  async setup(ctx) {
    const hooks = await legacy.server({} as never);
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
      for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
        if (event.type === "session.deleted") await hooks.event!({ event: { type: "session.deleted", properties: { info: { id: event.data.sessionID } } } as never });
      }
    })();
    // Observe the subscription immediately; only intentional shutdown suppresses an error.
    const observed = events.catch(error => { if (!abort.signal.aborted) console.error("agent-atexit event subscription failed", error); });
    return async () => { abort.abort(); await observed; await hooks.dispose!(); };
  },
} satisfies Plugin.Plugin;
