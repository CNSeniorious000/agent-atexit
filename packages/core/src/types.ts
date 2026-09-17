export type RegistrationState = "provisional" | "pending" | "claimed" | "running" | "succeeded" | "failed" | "cancelled";

export interface RegisterInput {
  argv: [string, ...string[]];
  cwd?: string;
  key?: string;
  timeoutMs?: number;
}

export interface SessionBinding {
  cwd: string;
  host: string;
  sessionId: string;
}

export interface RegistrationRecord {
  argv: [string, ...string[]];
  boundAt?: string;
  cancelledAt?: string;
  claimedAt?: string;
  completedAt?: string;
  createdAt: string;
  createdOrder?: number;
  cwd?: string;
  error?: string;
  exitCode?: number | null;
  host?: string;
  id: string;
  key?: string;
  runId?: string;
  sessionKey?: string;
  startedAt?: string;
  state: RegistrationState;
  timeoutMs: number;
}

export interface RunRecord {
  actionIds: string[];
  completedAt?: string;
  createdAt: string;
  host: string;
  id: string;
  sessionKey: string;
  startedAt?: string;
  state: "claimed" | "running" | "completed";
}

export interface BindResult {
  lateRun?: RunRecord;
  registration: RegistrationRecord;
}

export interface CancelResult {
  cancelled: boolean;
  registration: RegistrationRecord;
}

export interface ExecuteRunResult {
  alreadyStarted: boolean;
  executed: string[];
  run: RunRecord;
}

