/** Shared helpers (runtime-neutral: Deno and Bun/Node). */

/** Minimal logger contract used by the library internals */
export interface Logger {
  // deno-lint-ignore no-explicit-any
  info: (message: string, ...args: any[]) => void;
  // deno-lint-ignore no-explicit-any
  error: (message: string, ...args: any[]) => void;
  // deno-lint-ignore no-explicit-any
  warn: (message: string, ...args: any[]) => void;
  // deno-lint-ignore no-explicit-any
  debug: (message: string, ...args: any[]) => void;
}

/** Raw command sender: node-redis v4/v5 `sendCommand(args)` */
export interface RawClient {
  isOpen: boolean;
  sendCommand(args: string[]): Promise<unknown>;
}

/** Reads an environment variable in Deno, Bun or Node; undefined when unavailable */
export function getEnv(name: string): string | undefined {
  try {
    // deno-lint-ignore no-explicit-any
    const g = globalThis as any;
    if (g.Deno?.env?.get) return g.Deno.env.get(name) ?? undefined;
    return g.process?.env?.[name] ?? undefined;
  } catch (_) {
    return undefined;
  }
}

/** Host name of this process (HOSTNAME env, then the OS host name) */
export function hostName(): string {
  const env = getEnv("HOSTNAME");
  if (env) return env;
  try {
    // deno-lint-ignore no-explicit-any
    const g = globalThis as any;
    if (g.Deno?.hostname) return g.Deno.hostname();
  } catch (_) {
    // no --allow-sys
  }
  return "unknown-host";
}

/** Process id when available, else a random suffix */
export function processId(): string {
  // deno-lint-ignore no-explicit-any
  const g = globalThis as any;
  const pid = g.Deno?.pid ?? g.process?.pid;
  return pid ? String(pid) : crypto.randomUUID().slice(0, 8);
}

/** Terminates the process (Deno or Bun/Node) */
export function exitProcess(code: number): void {
  // deno-lint-ignore no-explicit-any
  const g = globalThis as any;
  if (g.Deno?.exit) g.Deno.exit(code);
  else if (g.process?.exit) g.process.exit(code);
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** Capped exponential backoff: 0 on the first retry, then base·2^(n-1) up to max */
export function backoffDelay(
  attempt: number,
  baseMs: number,
  maxMs: number,
): number {
  if (attempt <= 0) return 0;
  const exp = Math.min(attempt - 1, 30);
  return Math.min(baseMs * 2 ** exp, maxMs);
}

/** Orders stream ids numerically ("ms-seq"); "-"/"+"-free ids only */
export function compareStreamIds(a: string, b: string): number {
  const [am, as = "0"] = a.split("-");
  const [bm, bs = "0"] = b.split("-");
  const A = BigInt(am), B = BigInt(bm);
  if (A !== B) return A < B ? -1 : 1;
  const AS = BigInt(as), BS = BigInt(bs);
  if (AS !== BS) return AS < BS ? -1 : 1;
  return 0;
}

/** Converts a flat RESP field list into an object */
export function fieldsToRecord(fields: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(fields)) return out;
  for (let i = 0; i + 1 < fields.length; i += 2) {
    out[String(fields[i])] = String(fields[i + 1]);
  }
  return out;
}

/** Error message + optional code as one line */
export function errorReason(error: unknown): string {
  if (error instanceof Error) {
    // deno-lint-ignore no-explicit-any
    const code = (error as any).code;
    return code ? `${code}: ${error.message}` : error.message;
  }
  return String(error);
}

/** Parses the csv host-bank list: trimmed, lowercased, deduplicated, empty entries dropped */
export function parseBankList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const v = part.trim().toLowerCase();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}
