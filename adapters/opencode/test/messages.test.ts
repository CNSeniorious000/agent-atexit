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
  two.messages.forEach((entry, index) => expect(entry).toBe(retained[index]!));
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

test("precise hints refer to source arguments and native tool positions",async()=>{const {transform}=await fixture(),a=part("completed","read result","read"),b=part(),c=part("completed","saved","write");b.state.input={command:"echo ok\nps -p 123 2>/dev/null"};c.state.input={content:"try{check()}catch(e){return false}"};const original=message([a,b,c]),before=structuredClone(original),output={messages:[original]};await transform({},output);const rendered=result(output.messages[0]!,2)!;expect(rendered).toContain("tool 2 bash.command: stderr discarded at lines 2");expect(rendered).toContain("tool 3 write.content: caught errors discarded at lines 1");expect(rendered.split("Verification warning (").length-1).toBe(1);expect(original).toEqual(before);const once=structuredClone(output);await transform({},output);expect(output).toEqual(once);});
test("adding a later hinted message keeps the prior request prefix stable",async()=>{const {transform}=await fixture(),value=part();value.state.input={command:"ps -p 123 2>/dev/null"};const first=message([value]),later=part("completed","saved","write");later.state.input={content:"try{check()}catch{}"};const one={messages:[first]},two={messages:[first,message([later])]};await transform({},one);await transform({},two);expect(two.messages[0]).toEqual(one.messages[0]);expect(result(two.messages[1]!)).toContain("tool 1 write.content");});
test("output text cannot manufacture source diagnostics",async()=>{const {transform}=await fixture(),value=part("completed","ps -p 123 2>/dev/null; catch{}"),output={messages:[message([value])]};await transform({},output);expect(result(output.messages[0]!)).not.toContain("Verification warning (");});
test("strict error handling gets only general batching guidance",async()=>{const {transform,reminder}=await fixture(),value=part("completed","saved","write");value.state.input={content:"try{check()}catch(e){if(e.code==='ESRCH')return false;throw e;}"};const output={messages:[message([value])]};await transform({},output);expect(result(output.messages[0]!)).toContain(reminder);expect(result(output.messages[0]!)).not.toContain("Verification warning (");});

for (const method of ["on", "once"]) test(`${method}: swallowed event errors receive a location-only hint`, async () => {
  const { transform } = await fixture(), value = part("completed", "saved", "write");
  value.state.input = { content: `const PRIVATE_SOURCE_MARKER = 1;\nsocket.${method}("error", () => resolve({ open: false }));` };
  const original = message([value]), before = structuredClone(original), output = { messages: [original] }; await transform({}, output);
  expect(result(output.messages[0]!)).toContain("tool 1 write.content: error callbacks discard diagnostics at lines 2");
  expect(result(output.messages[0]!)).not.toContain("PRIVATE_SOURCE_MARKER"); expect(original).toEqual(before);
});
test("propagated or inspected event errors do not trigger the discarded-error hint", async () => {
  const { transform } = await fixture();
  for (const content of ['socket.on("error", reject);', 'socket.once("error", (error) => resolve({ code: error.code }));', 'socket.on("error", () => { throw new Error("failed"); });', 'socket.on("error", () => { console.error("connection failed"); resolve(false); });']) {
    const value = part("completed", "saved", "write"); value.state.input = { content }; const output = { messages: [message([value])] }; await transform({}, output);
    expect(result(output.messages[0]!)).not.toContain("error callbacks discard diagnostics");
  }
});

for (const stdio of ["['ignore', 'pipe', 'pipe']", '"pipe"']) test(`detached ${stdio} receives a conditional lifetime hint without quoting source`, async () => {
  const { transform } = await fixture(), value = part("completed", "saved", "write");
  value.state.input = { content: `const PRIVATE_SOURCE_MARKER = 1;
const child = spawn(command, {detached: true, stdio: ${stdio}});
child.stdout.pipe(log);` };
  const original = message([value]), before = structuredClone(original), output = { messages: [original] }; await transform({}, output);
  const text = result(output.messages[0]!)!; expect(text).toContain("write.content: piped stdio at line 2"); expect(text).toContain("If the child outlives its launcher");
  expect(text).toContain("even when forwarded to files"); expect(text).toContain("Detached mode and unref() leave these pipes attached"); expect(text).toContain("Before launching such a child"); expect(text).not.toContain("PRIVATE_SOURCE_MARKER"); expect(original).toEqual(before);
  const once = structuredClone(output); await transform({}, output); expect(output).toEqual(once);
});
test("direct descriptors and attached pipes do not trigger detached lifetime advice", async () => {
  const { transform } = await fixture();
  for (const content of ["spawn(cmd, {detached: true, stdio: ['ignore', outFd, errFd]})", "spawn(cmd, {detached: true, stdio: 'ignore'})", "spawn(cmd, {stdio: 'pipe'})", "spawn(cmd, {detached: false, stdio: ['ignore', 'pipe', 'pipe']})"]) {
    const value = part("completed", "saved", "write"); value.state.input = { content }; const output = { messages: [message([value])] }; await transform({}, output);
    expect(result(output.messages[0]!)).not.toContain("Detached stdio warning");
  }
});
test("lifetime hints preserve request prefixes and coexist with discarded-error hints", async () => {
  const { transform } = await fixture(), value = part("completed", "saved", "write"); value.state.input = { content: "spawn(cmd, {detached: true, stdio: 'pipe'}); try {check()} catch {}" };
  const original = message([value]), first = { messages: [original] }, second = { messages: [original, message([part()])] }; await transform({}, first); await transform({}, second);
  expect(second.messages[0]).toEqual(first.messages[0]); expect(result(first.messages[0]!)).toContain("Detached stdio warning"); expect(result(first.messages[0]!)).toContain("Verification warning");
  const onlyOutput = { messages: [message([part("completed", "spawn(cmd, {detached: true, stdio: 'pipe'})")])] }; await transform({}, onlyOutput);
  expect(result(onlyOutput.messages[0]!)).not.toContain("Detached stdio warning");
});

for (const pipe of ['2>&1 | grep missing', '2>&1  | rg missing', '|& awk "{print $1}"', '2>&1 | sed -n /missing/p']) test(`filtered stderr ${pipe} receives a source hint`, async () => {
  const { transform } = await fixture(), value = part(); value.state.input = { command: `echo PRIVATE_SOURCE_MARKER\nps -p 123 ${pipe}` };
  const original = message([value]), before = structuredClone(original), first = { messages: [original] }, later = { messages: [original, message([part()])] };
  await transform({}, first); await transform({}, later); const text = result(first.messages[0]!)!;
  expect(text).toContain("tool 1 bash.command: stderr filtered at lines 2"); expect(text).not.toContain("PRIVATE_SOURCE_MARKER"); expect(original).toEqual(before); expect(later.messages[0]).toEqual(first.messages[0]);
  const once = structuredClone(first); await transform({}, first); expect(first).toEqual(once);
});
test("preserved stderr and unfiltered streams do not get the filtered-stderr hint", async () => {
  const { transform } = await fixture();
  for (const command of ['ps -p 123 | grep missing', 'ps -p 123 2 >&1 | rg missing', 'ps -p 123 12>&1 | grep missing', 'ps -p 123 2>&1 | cat', 'ps -p 123 2>&1', 'ps -p 123 2>errors.log | rg missing']) {
    const value = part(); value.state.input = { command }; const output = { messages: [message([value])] }; await transform({}, output); expect(result(output.messages[0]!)).not.toContain("stderr filtered at lines");
  }
});

test("added patch lines receive diagnostic and lifetime hints at original patch positions", async () => {
  const { transform } = await fixture(), value = part("completed", "patched", "apply_patch");
  value.state.input = { patchText: "*** Begin Patch\n*** Add File: worker.js\n+try { check() } catch {}\n+spawn(cmd, { detached: true, stdio: 'pipe' });\n+const PRIVATE_SOURCE_MARKER = 1;\n*** End Patch" };
  const original = message([value]), before = structuredClone(original), first = { messages: [original] }, later = { messages: [original, message([part()])] };
  await transform({}, first); await transform({}, later); const text = result(first.messages[0]!)!;
  expect(text).toContain("tool 1 apply_patch.patchText: caught errors discarded at lines 3"); expect(text).toContain("piped stdio at line 4"); expect(text).not.toContain("PRIVATE_SOURCE_MARKER");
  expect(original).toEqual(before); expect(later.messages[0]).toEqual(first.messages[0]); const once = structuredClone(first); await transform({}, first); expect(first).toEqual(once);
});
test("removed and context patch lines cannot manufacture source hints", async () => {
  const { transform } = await fixture(), value = part("completed", "patched", "apply_patch");
  value.state.input = { patchText: "*** Begin Patch\n*** Update File: worker.js\n@@\n-try { check() } catch {}\n spawn(cmd, { detached: true, stdio: 'pipe' });\n+try { check() } catch (e) { throw e; }\n+++catch{}\n*** End Patch" };
  const output = { messages: [message([value])] }; await transform({}, output); expect(result(output.messages[0]!)).not.toContain("Verification warning"); expect(result(output.messages[0]!)).not.toContain("Detached stdio warning");
});

test("explicit synchronous stderr capture receives a conditional source hint", async () => {
  const { transform } = await fixture();
  for (const command of ['execSync("check", {stdio: "pipe"});', 'execFileSync("check", [], {stdio: ["ignore", "pipe", "pipe"]});', 'spawnSync("check", {stdio: [0, 1, "pipe"]});']) {
    const value = part(); value.state.input = { command: `const PRIVATE_SOURCE_MARKER = 1;\n${command}` }; const original = message([value]), before = structuredClone(original), output = { messages: [original] }; await transform({}, output);
    const text = result(output.messages[0]!)!; expect(text).toContain("subprocess stderr captured at line 2"); expect(text).not.toContain("PRIVATE_SOURCE_MARKER"); expect(original).toEqual(before);
    const once = structuredClone(output); await transform({}, output); expect(output).toEqual(once);
  }
});
test("default sync stderr and explicit noncaptured stderr do not receive the capture hint", async () => {
  const { transform } = await fixture();
  for (const command of ['execSync("check");', 'execSync("check", {stdio: "inherit"});', 'execSync("check", {stdio: ["pipe", "pipe", "inherit"]});', 'spawn("check", {stdio: "pipe"});']) {
    const value = part(); value.state.input = { command }; const output = { messages: [message([value])] }; await transform({}, output); expect(result(output.messages[0]!)).not.toContain("subprocess stderr captured");
  }
});
test("capture hints preserve request prefixes and cannot come from tool output", async () => {
  const { transform } = await fixture(), command = 'execSync("check", {stdio: "pipe"});', value = part(); value.state.input = { command };
  const first = { messages: [message([value])] }, later = { messages: [...first.messages, message([part()])] }; await transform({}, first); await transform({}, later); expect(later.messages[0]).toEqual(first.messages[0]);
  const onlyOutput = { messages: [message([part("completed", command)])] }; await transform({}, onlyOutput); expect(result(onlyOutput.messages[0]!)).not.toContain("subprocess stderr captured");
});

test("silent curl fragments receive location-only hints without changing stored results", async () => {
  const { transform } = await fixture();
  for (const flags of ["-s", "-fs", "--silent"]) {
    const value = part(); value.state.input = { command: `echo PRIVATE_SOURCE_MARKER\ncurl ${flags} http://127.0.0.1:12345 || echo absent` };
    const original = message([value]), before = structuredClone(original), output = { messages: [original] }; await transform({}, output); const text = result(output.messages[0]!)!;
    expect(text).toContain("curl diagnostics suppressed at lines 2"); expect(text).not.toContain("PRIVATE_SOURCE_MARKER"); expect(original).toEqual(before);
    const once = structuredClone(output); await transform({}, output); expect(output).toEqual(once);
  }
});
test("curl show-error preserves diagnostics with short or long silent flags", async () => {
  const { transform } = await fixture();
  for (const command of ["curl -sS url", "curl -fsS url", "curl -s -S url", "curl --silent --show-error url", "curl --show-error --silent url", "curl -s --show-error url", "curl url", "curl --silentish url", "curlish -s url"]) {
    const value = part(); value.state.input = { command }; const output = { messages: [message([value])] }; await transform({}, output); expect(result(output.messages[0]!)).not.toContain("curl diagnostics suppressed");
  }
});
test("silent curl hints keep request prefixes and distinguish adjacent commands", async () => {
  const { transform } = await fixture(), value = part(); value.state.input = { command: 'curl -s url; curl -sS another' };
  const first = { messages: [message([value])] }, later = { messages: [...first.messages, message([part()])] }; await transform({}, first); await transform({}, later);
  expect(result(first.messages[0]!)).toContain("curl diagnostics suppressed at lines 1"); expect(later.messages[0]).toEqual(first.messages[0]);
  const onlyOutput = { messages: [message([part("completed", "curl -s url")])] }; await transform({}, onlyOutput); expect(result(onlyOutput.messages[0]!)).not.toContain("curl diagnostics suppressed");
});
