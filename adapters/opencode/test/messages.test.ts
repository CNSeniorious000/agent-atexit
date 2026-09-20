import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Hooks, PluginModule } from "@opencode-ai/plugin";

type Transform = NonNullable<Hooks["experimental.chat.messages.transform"]>;
type Message = Parameters<Transform>[1]["messages"][number];
type ToolPart = Extract<Message["parts"][number], { type: "tool" }>;
const roots: string[] = [];
const timing = '\n\n<tool_timing start="1970-01-01T00:00:01.000Z" end="1970-01-01T00:00:02.000Z" />';

afterEach(async () => {
  delete process.env.AGENT_ATEXIT_STATE_DIR;
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "agent-atexit-messages-")); roots.push(root); process.env.AGENT_ATEXIT_STATE_DIR = root;
  const url = pathToFileURL(resolve(import.meta.dirname, "../dist/server.js")); url.searchParams.set("test", crypto.randomUUID());
  const hooks = await ((await import(url.href)).default as PluginModule).server({} as never), system = { system: [] as string[] };
  await hooks["experimental.chat.system.transform"]!({ model: {} as never }, system);
  return { transform: hooks["experimental.chat.messages.transform"]!, reminder: `\n\n<system-reminder>\n${system.system[0]}\n</system-reminder>` };
}

function part(status: "completed" | "error" = "completed", value = "raw", tool = "bash"): ToolPart {
  const common = { input: { command: "fixture" }, time: { start: 1000, end: 2000 } };
  return { id: "part", messageID: "message", sessionID: "session", callID: "call", type: "tool", tool,
    state: status === "completed" ? { ...common, status, output: value, title: "title", metadata: { exit: 0 } } : { ...common, status, error: value } };
}
const message = (parts: Message["parts"], role: "assistant" | "user" = "assistant"): Message => ({ info: { id: "message", role } as Message["info"], parts });
const result = (entry: Message, index = 0) => { const state = (entry.parts[index] as ToolPart).state; return state.status === "completed" ? state.output : state.status === "error" ? state.error : undefined; };

for (const status of ["completed", "error"] as const) test(`${status}: host array receives copies while stored data stays immutable`, async () => {
  const { transform, reminder } = await fixture(), original = message([part(status)]), before = structuredClone(original);
  Object.freeze((original.parts[0] as ToolPart).state); Object.freeze(original.parts[0]); Object.freeze(original.parts); Object.freeze(original);
  // OpenCode consumes the original array reference after the hook returns.
  const hostMessages = [original], output = { messages: hostMessages }; await transform({}, output);
  expect(output.messages).toBe(hostMessages); expect(result(hostMessages[0]!)).toBe("raw" + timing + reminder); expect(original).toEqual(before);
  const storedPart = before.parts[0] as ToolPart, field = status === "completed" ? "output" : "error";
  expect(hostMessages[0]!.parts[0]).toEqual({ ...storedPart, state: { ...storedPart.state, [field]: "raw" + timing + reminder } });
  const once = structuredClone(output); await transform({}, output); expect(output).toEqual(once);
});

test("fresh requests preserve completed prefixes and leave stored history unchanged", async () => {
  const { transform, reminder } = await fixture(), first = message([part("completed", "first")]), second = message([part("completed", "left"), part("error", "right")]);
  const one = { messages: [first] }; await transform({}, one);
  const two = { messages: [first, second] }; await transform({}, two);
  expect(result(one.messages[0]!)).toBe("first" + timing + reminder); expect(two.messages[0]).toEqual(one.messages[0]);
  expect(result(two.messages[1]!, 0)).toBe("left" + timing); expect(result(two.messages[1]!, 1)).toBe("right" + timing + reminder);
  expect(result(first)).toBe("first"); expect(result(second, 1)).toBe("right");
  const once = structuredClone(two), retained = two.messages.slice(); await transform({}, two); expect(two).toEqual(once);
  two.messages.forEach((entry, index) => expect(entry).toBe(retained[index]));
});

test("historical planning and pending messages do not suppress later work reminders", async () => {
  const { transform, reminder } = await fixture(), pending = { ...part(), state: { status: "running", input: {}, time: { start: 1000 } } } as ToolPart;
  const output = { messages: [message([part("completed", "plan", "todowrite")]), message([pending]), message([part("error", "failure")])] };
  await transform({}, output);
  expect(result(output.messages[0]!)).toBe("plan" + timing); expect(output.messages[1]!.parts[0]).toBe(pending);
  expect(result(output.messages[2]!)).toBe("failure" + timing + reminder);
});

test("pending siblings and planning results do not become policy carriers", async () => {
  const { transform, reminder } = await fixture(), pending = { ...part(), state: { status: "running", input: {}, time: { start: 1000 } } } as ToolPart;
  const output = { messages: [message([part("error", "failure"), pending, part("completed", "plan", "todowrite")])] }; await transform({}, output);
  expect(result(output.messages[0]!, 0)).toBe("failure" + timing + reminder); expect(output.messages[0]!.parts[1]).toBe(pending);
  expect(result(output.messages[0]!, 2)).toBe("plan" + timing);
});

test("planning-only and user turns preserve prior reminders without adding new ones", async () => {
  const { transform, reminder } = await fixture(), old = message([part()]), todo = message([part("completed", "plan", "todowrite")]);
  for (const last of [todo, message([], "user"), message([])]) {
    const output = { messages: [old, last] }; await transform({}, output);
    expect(result(output.messages[0]!)).toBe("raw" + timing + reminder); expect(JSON.stringify(output.messages[1])).not.toContain("<system-reminder>");
  }
  const empty = { messages: [] }; await transform({}, empty); expect(empty.messages).toEqual([]);
});

test("invalid and compacted intervals cannot become execution evidence", async () => {
  const { transform, reminder } = await fixture();
  for (const time of [undefined, { start: NaN, end: 2000 }, { start: 1000, end: Infinity }, { start: 3000, end: 2000 }, { start: 1000, end: 1e20 },
    { start: 1.5, end: 2000 }, { start: "1000", end: 2000 }, { start: 1000, end: 2000, compacted: 3000 }]) {
    const value = part(); Object.assign(value.state, { time }); const original = structuredClone(value), output = { messages: [message([value])] };
    await transform({}, output); expect(result(output.messages[0]!)).toBe("raw" + reminder); expect(value).toEqual(original);
  }
});

test("concurrent requests do not share reminder placement", async () => {
  const { transform, reminder } = await fixture(), a = { messages: [message([part("completed", "A")])] }, b = { messages: [message([part("completed", "B")])] };
  await Promise.all([transform({}, a), transform({}, b)]);
  expect(result(a.messages[0]!)).toBe("A" + timing + reminder); expect(result(b.messages[0]!)).toBe("B" + timing + reminder);
});
