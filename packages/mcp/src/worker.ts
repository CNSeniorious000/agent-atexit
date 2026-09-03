import { executeRun } from "@agent-atexit/core";

function valueAfter(flag: string): string {
  const index = process.argv.indexOf(flag);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (!value) throw new Error(`missing ${flag}`);
  return value;
}

await executeRun(valueAfter("--state-dir"), valueAfter("--run-id"));

