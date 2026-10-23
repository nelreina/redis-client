/**
 * Consumer slot lease: a stable, bounded consumer name `<serviceName>-<n>` per pod
 * (proposal §4.2 `consumer-slot:<svc>:<n>`, §4.7).
 *
 * - claim: lowest free n starting at 1, `SET <prefix>:<svc>:<n> <podName> NX PX ttlMs`
 *   (a slot that already holds this pod name is re-adopted)
 * - renew: every renewMs, fenced compare-and-renew (PEXPIRE only while the value is
 *   still this pod), so a pod never extends a slot another pod holds
 * - lost lease (renew returned 0): try `SET NX` on the same slot; when another pod
 *   holds it, claim a new slot and hand the promise of it to `onLost`
 * - release: fenced DEL (only if the slot is still ours)
 * - env `CONSUMER_NAME` wins over the lease (no key is written then)
 */
import {
  errorReason,
  getEnv,
  hostName,
  type Logger,
  processId,
  type RawClient,
} from "./util.ts";

/** Fenced renew: PEXPIRE only while the slot still holds this pod name */
export const RENEW_SCRIPT =
  "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('PEXPIRE',KEYS[1],ARGV[2]) else return 0 end";

/** Fenced release: DEL only while the slot still holds this pod name */
export const RELEASE_SCRIPT =
  "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end";

export const DEFAULT_SLOT_PREFIX = "ynohub:config:consumer-slot";

/** Options of `claimConsumerSlot()` */
export interface ConsumerSlotOptions {
  /** Lease TTL (default 30000) */
  ttlMs?: number;
  /** Renew interval (default 10000) */
  renewMs?: number;
  /** Key prefix; the slot key is `<keyPrefix>:<serviceName>:<n>` (default "ynohub:config:consumer-slot") */
  keyPrefix?: string;
  /** Value stored in the slot (default env HOSTNAME, else `<host>:<pid>`) */
  podName?: string;
  /** Highest slot number tried (default 1000) */
  maxSlots?: number;
  /**
   * Called when the lease was lost to another pod. The argument resolves to this
   * same slot object once it holds a new slot (its `name`/`n` changed), or rejects
   * when no slot could be claimed. Never keep consuming under the old name.
   */
  onLost?: (newSlot: Promise<ConsumerSlot>) => void;
  /** Env var whose value wins over the lease (default "CONSUMER_NAME"); "" disables */
  envName?: string;
  logger?: Logger;
}

/** A claimed consumer slot */
export interface ConsumerSlot {
  /** Consumer name: `<serviceName>-<n>`, or the CONSUMER_NAME env value */
  readonly name: string;
  /** Slot number (0 when the name came from CONSUMER_NAME) */
  readonly n: number;
  /** Redis key of the slot ("" when not leased) */
  readonly key: string;
  /** Value stored in the slot */
  readonly podName: string;
  /** false when the name came from CONSUMER_NAME (no lease) */
  readonly leased: boolean;
  /** Stops renewing and deletes the slot key if it is still ours */
  release(): Promise<void>;
}

class StaticSlot implements ConsumerSlot {
  readonly key = "";
  readonly leased = false;
  constructor(
    readonly name: string,
    readonly n: number,
    readonly podName: string,
  ) {}
  release(): Promise<void> {
    return Promise.resolve();
  }
}

/** Lease-backed slot with fenced renew */
export class ConsumerSlotLease implements ConsumerSlot {
  readonly leased = true;
  private _n = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private tick: Promise<void> | null = null;
  private reclaiming: Promise<ConsumerSlot> | null = null;
  private released = false;
  private lastRenewOk = 0;
  private renewErrors = 0;

  private readonly ttlMs: number;
  private readonly renewMs: number;
  private readonly keyPrefix: string;
  private readonly maxSlots: number;
  private readonly logger: Logger;
  private readonly onLost?: (newSlot: Promise<ConsumerSlot>) => void;

  constructor(
    private readonly client: RawClient,
    readonly serviceName: string,
    readonly podName: string,
    opts: ConsumerSlotOptions,
  ) {
    this.ttlMs = opts.ttlMs ?? 30000;
    this.renewMs = opts.renewMs ?? 10000;
    this.keyPrefix = opts.keyPrefix ?? DEFAULT_SLOT_PREFIX;
    this.maxSlots = opts.maxSlots ?? 1000;
    this.logger = opts.logger ?? console;
    this.onLost = opts.onLost;
  }

  get n(): number {
    return this._n;
  }

  get name(): string {
    return `${this.serviceName}-${this._n}`;
  }

  get key(): string {
    return this.slotKey(this._n);
  }

  private slotKey(n: number): string {
    return `${this.keyPrefix}:${this.serviceName}:${n}`;
  }

  /** Claims the lowest free slot (or re-adopts one holding this pod name) */
  async claim(): Promise<this> {
    for (let n = 1; n <= this.maxSlots; n++) {
      const key = this.slotKey(n);
      const ok = await this.client.sendCommand([
        "SET",
        key,
        this.podName,
        "NX",
        "PX",
        String(this.ttlMs),
      ]);
      let mine = ok === "OK";
      if (!mine) {
        // re-adopt our own slot (same pod name, e.g. a container restart within the TTL)
        const renewed = await this.client.sendCommand([
          "EVAL",
          RENEW_SCRIPT,
          "1",
          key,
          this.podName,
          String(this.ttlMs),
        ]);
        mine = Number(renewed) === 1;
      }
      if (mine) {
        this._n = n;
        this.lastRenewOk = Date.now();
        this.startTimer();
        this.logger.info(
          `🔖 consumer slot ${key} claimed → consumer name ${this.name}`,
        );
        return this;
      }
    }
    throw new Error(
      `no free consumer slot for ${this.serviceName} (tried 1..${this.maxSlots})`,
    );
  }

  private startTimer(): void {
    if (this.timer || this.released) return;
    this.timer = setInterval(() => {
      if (this.tick || this.reclaiming || this.released) return;
      this.tick = this.renew().finally(() => (this.tick = null));
    }, this.renewMs);
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One fenced renew; on a lost lease re-acquire or move to a new slot */
  async renew(): Promise<void> {
    if (this.released || this.reclaiming) return;
    const key = this.key;
    let renewed: unknown;
    try {
      renewed = await this.client.sendCommand([
        "EVAL",
        RENEW_SCRIPT,
        "1",
        key,
        this.podName,
        String(this.ttlMs),
      ]);
    } catch (error) {
      this.renewErrors++;
      if (this.renewErrors === 1 || this.renewErrors % 10 === 0) {
        this.logger.warn(
          `consumer slot ${key}: renew failed (${this.renewErrors}x, last ok ${
            Date.now() - this.lastRenewOk
          } ms ago): ${errorReason(error)}`,
        );
      }
      return;
    }
    this.renewErrors = 0;
    if (Number(renewed) === 1) {
      this.lastRenewOk = Date.now();
      return;
    }
    if (this.released) return;
    // lease lapsed (expired or overwritten): try to take the same slot back
    try {
      const again = await this.client.sendCommand([
        "SET",
        key,
        this.podName,
        "NX",
        "PX",
        String(this.ttlMs),
      ]);
      if (again === "OK") {
        this.lastRenewOk = Date.now();
        this.logger.warn(
          `consumer slot ${key}: lease had lapsed, re-acquired (name ${this.name} unchanged)`,
        );
        return;
      }
    } catch (error) {
      this.logger.warn(
        `consumer slot ${key}: re-acquire failed: ${errorReason(error)}`,
      );
      return;
    }
    const holder = await this.client.sendCommand(["GET", key]).catch(() =>
      null
    );
    this.logger.error(
      `consumer slot ${key}: lease lost to ${
        holder ?? "?"
      }; claiming a new slot`,
    );
    const promise = this.moveToNewSlot(String(this.name));
    if (this.onLost) {
      try {
        this.onLost(promise);
      } catch (error) {
        this.logger.error(`onLost threw: ${errorReason(error)}`);
      }
    } else {
      promise.catch(() => {});
    }
    await promise.catch(() => {});
  }

  private moveToNewSlot(oldName: string): Promise<ConsumerSlot> {
    this.stopTimer();
    this.reclaiming = this.claim().then(
      (slot) => {
        this.logger.warn(`consumer name changed ${oldName} → ${slot.name}`);
        return slot as ConsumerSlot;
      },
    ).finally(() => (this.reclaiming = null));
    return this.reclaiming;
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    this.stopTimer();
    if (this.tick) await this.tick.catch(() => {});
    if (this.reclaiming) await this.reclaiming.catch(() => {});
    if (!this._n) return;
    try {
      await this.client.sendCommand([
        "EVAL",
        RELEASE_SCRIPT,
        "1",
        this.key,
        this.podName,
      ]);
      this.logger.info(`🔖 consumer slot ${this.key} released`);
    } catch (error) {
      this.logger.warn(
        `consumer slot ${this.key}: release failed: ${errorReason(error)}`,
      );
    }
  }
}

/** Default pod name: HOSTNAME env (the pod name on Kubernetes), else `<host>:<pid>` */
export function defaultPodName(): string {
  const env = getEnv("HOSTNAME");
  return env ? env : `${hostName()}:${processId()}`;
}

/**
 * Claims a consumer slot for `serviceName`. See {@link ConsumerSlotOptions}.
 */
export async function claimConsumerSlot(
  client: RawClient,
  serviceName: string,
  opts: ConsumerSlotOptions = {},
): Promise<ConsumerSlot> {
  const envName = opts.envName ?? "CONSUMER_NAME";
  const fromEnv = envName ? getEnv(envName) : undefined;
  const podName = opts.podName ?? defaultPodName();
  if (fromEnv) {
    const m = /-(\d+)$/.exec(fromEnv);
    (opts.logger ?? console).info(
      `🔖 consumer name ${fromEnv} from ${envName} (no slot lease)`,
    );
    return new StaticSlot(fromEnv, m ? Number(m[1]) : 0, podName);
  }
  const lease = new ConsumerSlotLease(client, serviceName, podName, opts);
  return await lease.claim();
}
