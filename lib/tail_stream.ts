/**
 * tailStream(): fan-out reader for a control stream (proposal §4.2/§4.5).
 * Plain XREAD BLOCK (no consumer group) on a dedicated connection, so every
 * replica sees every entry; resumes from the last id it handled, also across
 * reconnects. stop() wakes the blocked read with CLIENT UNBLOCK.
 */
import {
  backoffDelay,
  compareStreamIds,
  errorReason,
  fieldsToRecord,
  type Logger,
  type RawClient,
  sleep,
} from "./util.ts";

/** Entry handed to the tailStream handler (nelreina envelope, parsed) */
export interface TailMessage {
  id: string;
  streamKey: string;
  event?: string;
  aggregateId?: string;
  timestamp?: string;
  serviceName?: string;
  /** JSON-parsed payload when it is JSON, else the raw string */
  payload: unknown;
  headers: Record<string, string>;
  /** All raw fields of the entry */
  fields: Record<string, string>;
}

/** Info passed to onTrimmed */
export interface TrimInfo {
  streamKey: string;
  /** Last id this reader had handled */
  lastId: string;
  /** Oldest id still in the stream (null when empty) */
  firstId: string | null;
  /** Highest id removed by trimming/XDEL (Redis ≥ 7), if known */
  maxDeletedId: string | null;
}

/** Options of `tailStream()` */
export interface TailStreamOptions {
  /** Read entries strictly after this id ("$" = only new ones, "0-0" = all) */
  fromId: string;
  /** Called once per entry, in order; a throw is logged and the tail continues */
  handler: (message: TailMessage) => void | Promise<void>;
  /** XREAD BLOCK in ms (default 5000) */
  blockMs?: number;
  /** XREAD COUNT (default 100) */
  count?: number;
  /**
   * Called when entries after `lastId` may have been trimmed away before they
   * were read (checked at start and after every read error/reconnect)
   */
  onTrimmed?: (info: TrimInfo) => void | Promise<void>;
}

/** Handle returned by `tailStream()` */
export interface TailHandle {
  /** Stops the reader (CLIENT UNBLOCK), waits for it and closes its connection */
  stop(): Promise<void>;
  /** Settles when the reader exits: resolves on stop(), rejects only if the reader could not start */
  done: Promise<void>;
  readonly lastId: string;
  readonly clientId: number;
  readonly running: boolean;
}

/** Dedicated connection contract (node-redis client) */
export interface DedicatedClient extends RawClient {
  connect(): Promise<unknown>;
  quit?(): Promise<unknown>;
  disconnect?(): Promise<unknown>;
}

function parseXInfo(raw: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!Array.isArray(raw)) return out;
  for (let i = 0; i + 1 < raw.length; i += 2) out[String(raw[i])] = raw[i + 1];
  return out;
}

function toMessage(
  streamKey: string,
  id: string,
  fields: Record<string, string>,
): TailMessage {
  let payload: unknown = fields.payload;
  try {
    if (typeof payload === "string") payload = JSON.parse(payload);
  } catch (_) {
    // not JSON
  }
  let headers: Record<string, string> = {};
  try {
    if (fields.headers) headers = JSON.parse(fields.headers);
  } catch (_) {
    // not JSON
  }
  return {
    id,
    streamKey,
    event: fields.event,
    aggregateId: fields.aggregateId,
    timestamp: fields.timestamp,
    serviceName: fields.serviceName,
    payload,
    headers,
    fields,
  };
}

/**
 * Starts a tail reader. `main` sends CLIENT UNBLOCK and XINFO; `dedicated` is a
 * fresh (not yet connected) duplicate used only for XREAD BLOCK.
 */
export function startTail(
  main: RawClient,
  dedicated: DedicatedClient,
  streamKey: string,
  opts: TailStreamOptions,
  logger: Logger,
): TailHandle {
  const blockMs = opts.blockMs ?? 5000;
  const count = opts.count ?? 100;
  let lastId = opts.fromId || "$";
  let running = true;
  let clientId = 0;

  const checkTrim = async () => {
    if (!opts.onTrimmed || lastId === "$") return;
    let info: Record<string, unknown>;
    try {
      info = parseXInfo(
        await main.sendCommand(["XINFO", "STREAM", streamKey]),
      );
    } catch (_) {
      return; // stream does not exist (yet): nothing was trimmed
    }
    const first = info["first-entry"];
    const firstId = Array.isArray(first) ? String(first[0]) : null;
    const maxDeleted = info["max-deleted-entry-id"] != null
      ? String(info["max-deleted-entry-id"])
      : null;
    // XTRIM does not move max-deleted-entry-id (only XDEL does), so the first
    // entry is the main signal; a false positive only costs the caller a resync
    const isZero = lastId === "0-0" || lastId === "0";
    let trimmed = false;
    if (!isZero && firstId && compareStreamIds(firstId, lastId) > 0) {
      trimmed = true;
    }
    if (
      !isZero && maxDeleted !== null && maxDeleted !== "0-0" &&
      compareStreamIds(maxDeleted, lastId) > 0
    ) {
      trimmed = true;
    }
    if (trimmed) {
      logger.warn(
        `tail ${streamKey}: entries after ${lastId} may have been trimmed (first ${firstId}, max deleted ${maxDeleted})`,
      );
      try {
        await opts.onTrimmed({
          streamKey,
          lastId,
          firstId,
          maxDeletedId: maxDeleted,
        });
      } catch (error) {
        logger.error(
          `tail ${streamKey}: onTrimmed threw: ${errorReason(error)}`,
        );
      }
    }
  };

  const run = async () => {
    await dedicated.connect();
    clientId = Number(await dedicated.sendCommand(["CLIENT", "ID"]));
    if (lastId === "$") {
      // pin "$" to a concrete id so a reconnect resumes instead of skipping
      try {
        const last = await main.sendCommand([
          "XREVRANGE",
          streamKey,
          "+",
          "-",
          "COUNT",
          "1",
        ]);
        lastId = Array.isArray(last) && Array.isArray(last[0])
          ? String(last[0][0])
          : "0-0";
      } catch (_) {
        lastId = "0-0";
      }
    }
    await checkTrim();
    let errors = 0;
    let recheck = false;
    while (running) {
      let raw: unknown;
      try {
        raw = await dedicated.sendCommand([
          "XREAD",
          "COUNT",
          String(count),
          "BLOCK",
          String(blockMs),
          "STREAMS",
          streamKey,
          lastId,
        ]);
        errors = 0;
      } catch (error) {
        if (!running) break;
        errors++;
        recheck = true;
        const wait = backoffDelay(errors, 500, 30000) || 200;
        logger.warn(
          `tail ${streamKey}: XREAD failed (${errors}x), retry in ${wait} ms: ${
            errorReason(error)
          }`,
        );
        for (let t = 0; t < wait && running; t += 100) await sleep(100);
        continue;
      }
      if (recheck && running) {
        recheck = false;
        await checkTrim();
      }
      if (!Array.isArray(raw)) continue;
      for (const streamRow of raw) {
        if (!Array.isArray(streamRow) || !Array.isArray(streamRow[1])) continue;
        for (const item of streamRow[1]) {
          if (!Array.isArray(item)) continue;
          const id = String(item[0]);
          lastId = id;
          try {
            await opts.handler(
              toMessage(streamKey, id, fieldsToRecord(item[1])),
            );
          } catch (error) {
            logger.error(
              `tail ${streamKey}: handler failed on ${id}: ${
                errorReason(error)
              }`,
            );
          }
        }
      }
    }
  };

  let exited = false;
  const done = run().finally(async () => {
    running = false;
    exited = true;
    await closeQuietly(dedicated);
  });
  done.catch(() => {});

  const stop = async () => {
    running = false;
    const unblock = async () => {
      if (exited || !clientId) return;
      try {
        await main.sendCommand(["CLIENT", "UNBLOCK", String(clientId)]);
      } catch (_) {
        // the loop exits on its own error
      }
    };
    await unblock();
    const iv = setInterval(unblock, 100);
    try {
      // a read queued while Redis is unreachable cannot be unblocked: force-close
      let to: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<string>((r) => {
        to = setTimeout(() => r("timeout"), blockMs + 2000);
      });
      const r = await Promise.race([
        done.then(() => "done", () => "done"),
        timeout,
      ]);
      clearTimeout(to);
      if (r === "timeout" && !exited && dedicated.disconnect) {
        await dedicated.disconnect().catch(() => {});
      }
      await done.catch(() => {});
    } finally {
      clearInterval(iv);
    }
  };

  return {
    stop,
    done,
    get lastId() {
      return lastId;
    },
    get clientId() {
      return clientId;
    },
    get running() {
      return running;
    },
  };
}

async function closeQuietly(c: DedicatedClient): Promise<void> {
  try {
    if (!c.isOpen) return;
    if (c.quit) await c.quit();
    else if (c.disconnect) await c.disconnect();
  } catch (_) {
    // already closed
  }
}
