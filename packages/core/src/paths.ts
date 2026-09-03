import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function resolveStateRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AGENT_ATEXIT_STATE_DIR) return resolve(env.AGENT_ATEXIT_STATE_DIR);
  if (env.CLAUDE_PLUGIN_DATA) return resolve(env.CLAUDE_PLUGIN_DATA, "atexit");
  if (env.PLUGIN_DATA) return resolve(env.PLUGIN_DATA, "atexit");
  if (env.KIMI_CODE_HOME) return resolve(env.KIMI_CODE_HOME, "atexit");
  if (env.XDG_STATE_HOME) return resolve(env.XDG_STATE_HOME, "agent-atexit");
  return join(homedir(), ".local", "state", "agent-atexit");
}

export function sessionKey(host: string, sessionId: string): string {
  return createHash("sha256").update(`${host}\0${sessionId}`).digest("hex");
}

