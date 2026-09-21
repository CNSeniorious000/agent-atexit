type ToolCall = { tool_name?: string; tool_input?: { command?: unknown; content?: unknown; new_string?: unknown; newString?: unknown } };
// These are source-text hints, never a verdict about a resource or a shell parser.
export function verificationFeedback(calls: readonly ToolCall[]): string {
  const locations: string[] = [];
  for (const [index, call] of calls.entries()) {
    const tool = call.tool_name?.toLowerCase(), input = call.tool_input;
    const field = tool === "bash" ? "command" : tool === "write" ? "content" : tool === "edit" ? (input?.new_string !== undefined ? "new_string" : "newString") : undefined;
    const source = field && input?.[field];
    if (typeof source !== "string") continue;
    const line = (offset: number) => source.slice(0, offset).split("\n").length;
    const discarded = [...source.matchAll(/(?:\b2\s*>>?|(?:^|\s)&>>?)\s*["']?\/dev\/null["']?/g), ...source.matchAll(/(?<!\d)1?>>?\s*["']?\/dev\/null["']?\s+2>&1/g)].map((match) => line(match.index));
    const caught: number[] = [];
    for (const match of source.matchAll(/\bcatch\s*(?:\(\s*([\w$]+)\s*\)\s*)?\{([^{}]*)\}/g)) {
      const body = match[2]!, parameter = match[1];
      // Propagating the failure or inspecting the caught error already preserves a useful distinction.
      if (/\bthrow\b|\breject\s*\(|\bprocess\.exit\s*\(\s*[1-9]/.test(body) || (parameter && new RegExp("(?:^|[^\\w$])" + parameter.replace(/[$]/g, "\\$") + "(?![\\w$])").test(body))) continue;
      caught.push(line(match.index));
    }
    const label = `tool ${index + 1} ${tool}.${field}`;
    if (discarded.length) locations.push(`${label}: stderr discarded at lines ${[...new Set(discarded)].slice(0, 4).join(",")}`);
    if (caught.length) locations.push(`${label}: caught errors discarded at lines ${[...new Set(caught)].slice(0, 4).join(",")}`);
    if (locations.length >= 3) break;
  }
  if (!locations.length) return "";
  return `Verification warning (${locations.slice(0, 3).join("; ")}). If this is a release check, discarded errors make its result inconclusive. Keep the affected fallback until you recheck the registered target with diagnostics preserved or obtain other evidence of that target’s release. Related state is insufficient; a successful release contract suffices.`;
}
