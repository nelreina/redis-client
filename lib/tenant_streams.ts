/**
 * TenantStreamManager: hot add/remove of per-tenant consumer loops
 * (proposal §4.5 "Reconcile, per runtime", Bun/Deno column).
 *
 * start(): claim consumer slot → lastId = XREVRANGE events + - COUNT 1 →
 *          reconcile("boot") → tail the control stream from lastId →
 *          reconcile every reconcileSec ("timer"), heartbeat every heartbeatSec.
 *
 * reconcile(reason) is serialized; calls made while one runs coalesce into one rerun.
 */
import type { EventHandler } from "@nelreina/redis-stream-event";
import type { ConsumerSlot, ConsumerSlotOptions } from "./consumer_slot.ts";
import type {
  TailHandle,
  TailMessage,
  TailStreamOptions,
} from "./tail_stream.ts";
import type { EventStreamHandle, StartEventStreamOptions } from "./types.ts";
import {
  backoffDelay,
  errorReason,
  exitProcess,
  getEnv,
  type Logger,
  parseBankList,
} from "./util.ts";

/** What the manager needs from RedisClient (kept structural to avoid an import cycle) */
export interface TenantStreamHost {
  readonly serviceName: string;
  readonly logger: Logger;
  // deno-lint-ignore no-explicit-any
  getConnection(): any;
  startEventStream(
    streamKey: string,
    opts: StartEventStreamOptions,
  ): EventStreamHandle;
  tailStream(streamKey: string, opts: TailStreamOptions): TailHandle;
  claimConsumerSlot(
    serviceName: string,
    opts?: ConsumerSlotOptions,
  ): Promise<ConsumerSlot>;
  ensureStreamGroup(
    streamKey: string,
    group: string,
    startId: string,
  ): Promise<void>;
  sweepIdleConsumers(
    streamKey: string,
    group: string,
    keep: string,
    idleMs: number,
  ): Promise<string[]>;
}

/** Options of `RedisClient.tenantStreams()` */
export interface TenantStreamsOptions {
  /** Tenant stream key = `<streamPrefix>:<bic>` (the services' STREAM env) */
  streamPrefix: string;
  /** Overrides the stream key per tenant */
  streamKeyFor?: (bic: string) => string;
  /** csv of active lowercase BICs (default "ynohub:config:host-banks:active") */
  activeKey?: string;
  /** INTEGER bumped by every config commit (default "ynohub:config:cache:generation") */
  generationKey?: string;
  /** Informational cache status (default "ynohub:config:cache:status") */
  statusKey?: string;
  /** Control stream (default env CONFIG_EVENTS_STREAM, else "ynohub:config:events") */
  eventsStream?: string;
  /** Group start id per tenant = GET `<activatedKeyPrefix>:<bic>` (default "ynohub:config:tenant-activated") */
  activatedKeyPrefix?: string;
  /** Heartbeat HASH `<appliedKeyPrefix>:<serviceName>:<consumerName>` (default "ynohub:config:applied") */
  appliedKeyPrefix?: string;
  /** Group name, slot and heartbeat service (default: the client's serviceName) */
  serviceName?: string;
  /** Event filter for the tenant loops (null/undefined = all) */
  events?: string[] | string | null;
  /** Message handler shared by all tenants (message.streamKey tells the tenant) */
  handler?: EventHandler;
  /** Per-tenant handler factory; wins over `handler` */
  handlerFor?: (bic: string) => EventHandler;
  /** Runs after the group exists and before the loop starts; a throw marks the tenant degraded */
  onTenantAdded?: (bic: string) => void | Promise<void>;
  /** Runs after the tenant's loop has stopped */
  onTenantRemoved?: (bic: string) => void | Promise<void>;
  /** Every control-stream entry (after the manager reacted to it) */
  onConfigEvent?: (message: TailMessage) => void | Promise<void>;
  /** Backstop reconcile interval in s (default env CONFIG_RECONCILE_SEC, else 60) */
  reconcileSec?: number;
  /** Heartbeat interval in s (default 30) */
  heartbeatSec?: number;
  /** Heartbeat TTL in s (default 120) */
  heartbeatTtlSec?: number;
  /** Written to the heartbeat: "all" | "tenants" | "none" (default "all") */
  hotReload?: string;
  /** XREADGROUP BLOCK of the tenant loops (default 5000) */
  blockMs?: number;
  /** Passed to every tenant loop */
  drain?: StartEventStreamOptions["drain"];
  /** Passed to every tenant loop */
  autoClaim?: StartEventStreamOptions["autoClaim"];
  /** Fixed consumer name (skips the slot lease; env CONSUMER_NAME does the same) */
  consumerName?: string;
  /** Slot lease options (onLost is owned by the manager) */
  slot?: Omit<ConsumerSlotOptions, "onLost">;
  /** Degraded retry backoff (default 1000 … 60000 ms) */
  retryBaseMs?: number;
  retryMaxMs?: number;
  /** XGROUP DELCONSUMER for other consumers with an empty PEL idle longer than this (default 3600000; 0 disables) */
  sweepIdleMs?: number;
  /** Interval of the idle-consumer sweep (default 600000) */
  sweepEveryMs?: number;
  /** Called when no new slot can be claimed after a lost lease (default: log + exit(1)) */
  onFatal?: (error: unknown) => void;
  logger?: Logger;
}

/** Why a tenant is not consuming */
export interface DegradedInfo {
  reason: string;
  /** "add" = onTenantAdded/ensureGroup failed; "loop" = the consumer loop failed */
  phase: "add" | "loop";
  attempts: number;
  since: string;
  nextRetryAt: string;
}

/** Summary of the last reconcile */
export interface ReconcileResult {
  reason: string;
  at: string;
  durationMs: number;
  generation: number | null;
  added: string[];
  removed: string[];
  restarted: string[];
  degraded: string[];
  skipped?: "empty-active-list" | "unchanged" | "stopped" | "error";
  error?: string;
}

/** Shape of `status()` (suitable for /health-check) */
export interface TenantStreamStatus {
  status: "starting" | "ok" | "degraded" | "stopped";
  serviceName: string;
  consumerName: string | null;
  slot: number | null;
  generation: number | null;
  cacheStatus: string | null;
  hotReload: string;
  tenants: string[];
  degraded: Record<string, DegradedInfo>;
  lastReconcile: ReconcileResult | null;
  tail: { running: boolean; lastId: string | null; stream: string };
}

interface TenantEntry {
  bic: string;
  streamKey: string;
  startId: string;
  handle: EventStreamHandle | null;
  startedAt: number;
  loopFailures: number;
  removing: boolean;
}

interface DegradedState {
  reason: string;
  phase: "add" | "loop";
  attempts: number;
  since: number;
  nextRetryAt: number;
}

export class TenantStreamManager {
  private readonly o: Required<
    Pick<
      TenantStreamsOptions,
      | "activeKey"
      | "generationKey"
      | "statusKey"
      | "eventsStream"
      | "activatedKeyPrefix"
      | "appliedKeyPrefix"
      | "serviceName"
      | "reconcileSec"
      | "heartbeatSec"
      | "heartbeatTtlSec"
      | "hotReload"
      | "blockMs"
      | "retryBaseMs"
      | "retryMaxMs"
      | "sweepIdleMs"
      | "sweepEveryMs"
    >
  >;
  private readonly logger: Logger;
  private readonly entries = new Map<string, TenantEntry>();
  private readonly degraded = new Map<string, DegradedState>();
  private readonly retryTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private slot: ConsumerSlot | null = null;
  private tail: TailHandle | null = null;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private queued: { reason: string; promise: Promise<ReconcileResult> } | null =
    null;
  private lastSeen: number | null = null;
  private cacheStatus: string | null = null;
  private last: ReconcileResult | null = null;
  private started = false;
  private stopped = false;
  private heartbeatKeyWritten: string | null = null;
  private leaseChange: Promise<void> | null = null;

  constructor(
    private readonly host: TenantStreamHost,
    private readonly opts: TenantStreamsOptions,
  ) {
    if (!opts.streamPrefix && !opts.streamKeyFor) {
      throw new Error("tenantStreams(): streamPrefix is required");
    }
    if (!opts.handler && !opts.handlerFor) {
      throw new Error("tenantStreams(): handler or handlerFor is required");
    }
    const envReconcile = Number(getEnv("CONFIG_RECONCILE_SEC"));
    this.o = {
      activeKey: opts.activeKey ?? "ynohub:config:host-banks:active",
      generationKey: opts.generationKey ?? "ynohub:config:cache:generation",
      statusKey: opts.statusKey ?? "ynohub:config:cache:status",
      eventsStream: opts.eventsStream ?? getEnv("CONFIG_EVENTS_STREAM") ??
        "ynohub:config:events",
      activatedKeyPrefix: opts.activatedKeyPrefix ??
        "ynohub:config:tenant-activated",
      appliedKeyPrefix: opts.appliedKeyPrefix ?? "ynohub:config:applied",
      serviceName: opts.serviceName ?? host.serviceName,
      reconcileSec: opts.reconcileSec ??
        (envReconcile > 0 ? envReconcile : 60),
      heartbeatSec: opts.heartbeatSec ?? 30,
      heartbeatTtlSec: opts.heartbeatTtlSec ?? 120,
      hotReload: opts.hotReload ?? "all",
      blockMs: opts.blockMs ?? 5000,
      retryBaseMs: opts.retryBaseMs ?? 1000,
      retryMaxMs: opts.retryMaxMs ?? 60000,
      sweepIdleMs: opts.sweepIdleMs ?? 3600000,
      sweepEveryMs: opts.sweepEveryMs ?? 600000,
    };
    this.logger = opts.logger ?? host.logger;
  }

  /** Current consumer name (null before start) */
  get consumerName(): string | null {
    return this.slot?.name ?? null;
  }

  private streamKey(bic: string): string {
    return this.opts.streamKeyFor
      ? this.opts.streamKeyFor(bic)
      : `${this.opts.streamPrefix}:${bic}`;
  }

  private appliedKey(name = this.slot?.name ?? ""): string {
    return `${this.o.appliedKeyPrefix}:${this.o.serviceName}:${name}`;
  }

  private now(): number {
    return Date.now();
  }

  /** Claims the slot, runs the boot reconcile, tails the control stream, starts the timers */
  async start(): Promise<void> {
    if (this.started) throw new Error("TenantStreamManager already started");
    this.started = true;
    const conn = this.host.getConnection();
    if (!conn.isOpen) await conn.connect();

    if (this.opts.consumerName) {
      const name = this.opts.consumerName;
      this.slot = {
        name,
        n: Number(/-(\d+)$/.exec(name)?.[1] ?? 0),
        key: "",
        podName: "",
        leased: false,
        release: () => Promise.resolve(),
      };
    } else {
      this.slot = await this.host.claimConsumerSlot(this.o.serviceName, {
        ...(this.opts.slot ?? {}),
        logger: this.opts.slot?.logger ?? this.logger,
        onLost: (p) => this.onLeaseLost(p),
      });
    }

    // control-stream position BEFORE the first reconcile: nothing committed
    // between the reconcile and the tail can be missed
    let lastId = "0-0";
    try {
      const last = await conn.sendCommand([
        "XREVRANGE",
        this.o.eventsStream,
        "+",
        "-",
        "COUNT",
        "1",
      ]);
      if (Array.isArray(last) && Array.isArray(last[0])) {
        lastId = String(last[0][0]);
      }
    } catch (error) {
      this.logger.warn(
        `tenantStreams: XREVRANGE ${this.o.eventsStream} failed: ${
          errorReason(error)
        }`,
      );
    }

    await this.reconcile("boot");

    this.tail = this.host.tailStream(this.o.eventsStream, {
      fromId: lastId,
      blockMs: 5000,
      handler: async (msg) => {
        if (msg.event === "CONFIG_CACHE_REFRESHED") {
          await this.reconcile("event");
        }
        if (this.opts.onConfigEvent) await this.opts.onConfigEvent(msg);
      },
      onTrimmed: () => {
        this.reconcile("trimmed");
      },
    });
    this.tail.done.catch((error) =>
      this.logger.error(
        `tenantStreams: control tail failed: ${errorReason(error)}`,
      )
    );

    this.reconcileTimer = setInterval(
      () => this.reconcile("timer"),
      this.o.reconcileSec * 1000,
    );
    this.heartbeatTimer = setInterval(
      () => this.heartbeat(),
      this.o.heartbeatSec * 1000,
    );
    if (this.o.sweepIdleMs > 0 && this.o.sweepEveryMs > 0) {
      this.sweepTimer = setInterval(
        () => this.sweepAll(),
        this.o.sweepEveryMs,
      );
    }
  }

  /** Tenants whose onTenantAdded succeeded and which are not removed (DB ready) */
  tenants(): string[] {
    return [...this.entries.keys()].sort();
  }

  /** Tenants with a running consumer loop */
  consuming(): string[] {
    return [...this.entries.values()]
      .filter((e) => e.handle !== null && !e.removing)
      .map((e) => e.bic)
      .sort();
  }

  status(): TenantStreamStatus {
    const degraded: Record<string, DegradedInfo> = {};
    for (const [bic, d] of this.degraded) {
      degraded[bic] = {
        reason: d.reason,
        phase: d.phase,
        attempts: d.attempts,
        since: new Date(d.since).toISOString(),
        nextRetryAt: new Date(d.nextRetryAt).toISOString(),
      };
    }
    let status: TenantStreamStatus["status"] = "ok";
    if (this.stopped) status = "stopped";
    else if (!this.last) status = "starting";
    else if (this.degraded.size) status = "degraded";
    return {
      status,
      serviceName: this.o.serviceName,
      consumerName: this.slot?.name ?? null,
      slot: this.slot?.n ?? null,
      generation: this.lastSeen,
      cacheStatus: this.cacheStatus,
      hotReload: this.o.hotReload,
      tenants: this.consuming(),
      degraded,
      lastReconcile: this.last,
      tail: {
        running: this.tail?.running ?? false,
        lastId: this.tail?.lastId ?? null,
        stream: this.o.eventsStream,
      },
    };
  }

  /**
   * Serialized reconcile. A call while one runs queues one rerun; further calls
   * join that queued rerun (a non-timer reason wins over "timer").
   */
  reconcile(reason = "manual"): Promise<ReconcileResult> {
    if (this.queued) {
      if (this.queued.reason === "timer") this.queued.reason = reason;
      return this.queued.promise;
    }
    const entry = {
      reason,
      promise: null as unknown as Promise<ReconcileResult>,
    };
    entry.promise = this.chain.catch(() => {}).then(() => {
      if (this.queued === entry) this.queued = null;
      return this.runReconcile(entry.reason);
    });
    this.queued = entry;
    this.chain = entry.promise;
    return entry.promise;
  }

  private hasPendingWork(): boolean {
    if (this.degraded.size) return true;
    for (const e of this.entries.values()) if (!e.handle) return true;
    return false;
  }

  private async runReconcile(reason: string): Promise<ReconcileResult> {
    const t0 = this.now();
    const result: ReconcileResult = {
      reason,
      at: new Date(t0).toISOString(),
      durationMs: 0,
      generation: this.lastSeen,
      added: [],
      removed: [],
      restarted: [],
      degraded: [],
    };
    const finish = async (skipped?: ReconcileResult["skipped"]) => {
      if (skipped) result.skipped = skipped;
      result.durationMs = this.now() - t0;
      if (skipped !== "unchanged" && skipped !== "stopped") this.last = result;
      if (skipped !== "stopped") await this.heartbeat();
      return result;
    };
    if (this.stopped) return finish("stopped");

    const conn = this.host.getConnection();
    let status: string | null, genRaw: string | null, activeRaw: string | null;
    try {
      [status, genRaw, activeRaw] = await conn.mGet([
        this.o.statusKey,
        this.o.generationKey,
        this.o.activeKey,
      ]);
    } catch (error) {
      result.error = errorReason(error);
      this.logger.warn(
        `tenantStreams: reconcile(${reason}) read failed: ${result.error}`,
      );
      return finish("error");
    }
    this.cacheStatus = status;
    const gen = genRaw === null || genRaw === undefined || genRaw === ""
      ? null
      : Number(genRaw);
    result.generation = gen;
    const active = parseBankList(activeRaw);

    if (active.length === 0) {
      this.logger.warn(
        `tenantStreams: ${this.o.activeKey} is empty or missing; keeping ${this.entries.size} tenant(s) (never evict all)`,
      );
      return finish("empty-active-list");
    }
    if (
      reason === "timer" && gen !== null && gen === this.lastSeen &&
      !this.hasPendingWork()
    ) {
      // unchanged generation and nothing to retry: heartbeat only
      await this.heartbeat();
      result.durationMs = this.now() - t0;
      result.skipped = "unchanged";
      return result;
    }
    if (gen !== null && this.lastSeen !== null && gen < this.lastSeen) {
      this.logger.warn(
        `tenantStreams: generation reset ${this.lastSeen} → ${gen}; full reconcile`,
      );
    }

    const desired = new Set(active);
    for (const bic of active) {
      if (this.stopped) break;
      const existing = this.entries.get(bic);
      if (existing?.handle) continue;
      const d = this.degraded.get(bic);
      if (d && d.nextRetryAt > this.now()) continue;
      if (!existing) {
        const ok = await this.addTenant(bic);
        if (ok) result.added.push(bic);
        else result.degraded.push(bic);
      } else {
        this.startLoop(existing);
        result.restarted.push(bic);
      }
    }
    for (const bic of [...this.entries.keys()]) {
      if (desired.has(bic)) continue;
      await this.removeTenant(bic);
      result.removed.push(bic);
    }
    for (const bic of [...this.degraded.keys()]) {
      if (!desired.has(bic)) this.clearDegraded(bic);
    }
    if (result.added.length || result.removed.length) {
      this.logger.info(
        `tenantStreams: reconcile(${reason}) gen=${gen} +[${result.added}] -[${result.removed}] consuming=[${this.consuming()}]`,
      );
    }
    this.lastSeen = gen;
    return finish();
  }

  /** ensureGroup → onTenantAdded → loop. false when the tenant ended up degraded */
  private async addTenant(bic: string): Promise<boolean> {
    const streamKey = this.streamKey(bic);
    const conn = this.host.getConnection();
    let startId = "$";
    try {
      const activated = await conn.get(`${this.o.activatedKeyPrefix}:${bic}`);
      if (activated) startId = activated;
      // pins the position even if the tenant ends up degraded
      await this.host.ensureStreamGroup(streamKey, this.o.serviceName, startId);
    } catch (error) {
      this.markDegraded(bic, "add", `ensure-group: ${errorReason(error)}`);
      return false;
    }
    try {
      if (this.opts.onTenantAdded) await this.opts.onTenantAdded(bic);
    } catch (error) {
      this.markDegraded(bic, "add", errorReason(error));
      return false;
    }
    if (this.stopped) {
      await this.callRemoved(bic);
      return false;
    }
    const entry: TenantEntry = {
      bic,
      streamKey,
      startId,
      handle: null,
      startedAt: 0,
      loopFailures: 0,
      removing: false,
    };
    this.entries.set(bic, entry);
    this.clearDegraded(bic);
    this.sweep(entry).catch(() => {});
    this.startLoop(entry);
    return true;
  }

  private startLoop(entry: TenantEntry): void {
    if (!this.slot || this.stopped) return;
    const handler = this.opts.handlerFor
      ? this.opts.handlerFor(entry.bic)
      : this.opts.handler!;
    const handle = this.host.startEventStream(entry.streamKey, {
      handler,
      events: this.opts.events ?? null,
      startId: entry.startId,
      consumerName: this.slot.name,
      group: this.o.serviceName,
      blockMs: this.o.blockMs,
      drain: this.opts.drain,
      autoClaim: this.opts.autoClaim,
    });
    entry.handle = handle;
    entry.startedAt = this.now();
    if (this.degraded.get(entry.bic)?.phase === "loop") {
      this.clearDegraded(entry.bic);
    }
    handle.done.then(
      () => {},
      (error) => {
        if (entry.handle !== handle || entry.removing || this.stopped) return;
        entry.handle = null;
        // a loop that ran for a while starts its backoff from scratch
        if (this.now() - entry.startedAt > this.o.retryMaxMs) {
          entry.loopFailures = 0;
        }
        entry.loopFailures++;
        this.markDegraded(
          entry.bic,
          "loop",
          `loop-failed: ${errorReason(error)}`,
          entry.loopFailures,
        );
        this.heartbeat();
      },
    );
  }

  private async removeTenant(bic: string): Promise<void> {
    const entry = this.entries.get(bic);
    if (!entry) return;
    entry.removing = true;
    const handle = entry.handle;
    entry.handle = null;
    if (handle) {
      try {
        await handle.stop();
      } catch (error) {
        this.logger.warn(
          `tenantStreams: stop ${bic} failed: ${errorReason(error)}`,
        );
      }
    }
    await this.callRemoved(bic);
    this.entries.delete(bic);
    this.clearDegraded(bic);
  }

  private async callRemoved(bic: string): Promise<void> {
    if (!this.opts.onTenantRemoved) return;
    try {
      await this.opts.onTenantRemoved(bic);
    } catch (error) {
      this.logger.error(
        `tenantStreams: onTenantRemoved(${bic}) failed: ${errorReason(error)}`,
      );
    }
  }

  private markDegraded(
    bic: string,
    phase: "add" | "loop",
    reason: string,
    attempts?: number,
  ): void {
    const prev = this.degraded.get(bic);
    const n = attempts ??
      (prev && prev.phase === phase ? prev.attempts + 1 : 1);
    const delay = Math.max(
      backoffDelay(n, this.o.retryBaseMs, this.o.retryMaxMs),
      this.o.retryBaseMs,
    );
    const nextRetryAt = this.now() + delay;
    this.degraded.set(bic, {
      reason,
      phase,
      attempts: n,
      since: prev?.since ?? this.now(),
      nextRetryAt,
    });
    this.logger.warn(
      `tenantStreams: ${bic} degraded (${reason}); retry #${n} in ${delay} ms`,
    );
    const old = this.retryTimers.get(bic);
    if (old) clearTimeout(old);
    this.retryTimers.set(
      bic,
      setTimeout(() => {
        this.retryTimers.delete(bic);
        if (!this.stopped) this.reconcile("retry");
      }, delay),
    );
  }

  private clearDegraded(bic: string): void {
    this.degraded.delete(bic);
    const t = this.retryTimers.get(bic);
    if (t) clearTimeout(t);
    this.retryTimers.delete(bic);
  }

  /** HSET applied:<svc>:<consumerName> … EX heartbeatTtlSec */
  async heartbeat(): Promise<void> {
    if (!this.slot || this.stopped) return;
    const key = this.appliedKey();
    const degraded: Record<string, string> = {};
    for (const [bic, d] of this.degraded) degraded[bic] = d.reason;
    try {
      await this.host.getConnection().multi()
        .hSet(key, {
          generation: this.lastSeen === null ? "" : String(this.lastSeen),
          tenants: this.consuming().join(","),
          degraded: JSON.stringify(degraded),
          hotReload: this.o.hotReload,
          consumerName: this.slot.name,
          ts: new Date().toISOString(),
        })
        .expire(key, this.o.heartbeatTtlSec)
        .exec();
      if (this.heartbeatKeyWritten && this.heartbeatKeyWritten !== key) {
        await this.host.getConnection().del(this.heartbeatKeyWritten);
      }
      this.heartbeatKeyWritten = key;
    } catch (error) {
      this.logger.warn(
        `tenantStreams: heartbeat failed: ${errorReason(error)}`,
      );
    }
  }

  private async sweep(entry: TenantEntry): Promise<void> {
    if (!this.slot || this.o.sweepIdleMs <= 0) return;
    try {
      const removed = await this.host.sweepIdleConsumers(
        entry.streamKey,
        this.o.serviceName,
        this.slot.name,
        this.o.sweepIdleMs,
      );
      if (removed.length) {
        this.logger.info(
          `tenantStreams: removed ${removed.length} idle consumer(s) from ${entry.streamKey}: ${removed}`,
        );
      }
    } catch (error) {
      this.logger.debug(
        `tenantStreams: sweep ${entry.streamKey}: ${errorReason(error)}`,
      );
    }
  }

  private async sweepAll(): Promise<void> {
    for (const e of this.entries.values()) {
      if (this.stopped) return;
      await this.sweep(e);
    }
  }

  /** Lease lost to another pod: stop every loop, wait for the new slot, restart the loops */
  private onLeaseLost(newSlot: Promise<ConsumerSlot>): void {
    const work = this.chain.catch(() => {}).then(async () => {
      const running = [...this.entries.values()];
      await Promise.all(running.map(async (e) => {
        const h = e.handle;
        e.handle = null;
        if (h) await h.stop().catch(() => {});
      }));
      const oldKey = this.heartbeatKeyWritten;
      try {
        this.slot = await newSlot;
      } catch (error) {
        this.logger.error(
          `tenantStreams: no new consumer slot after a lost lease: ${
            errorReason(error)
          }`,
        );
        (this.opts.onFatal ?? ((_e: unknown) => exitProcess(1)))(error);
        return;
      }
      if (this.stopped) return;
      for (const e of running) {
        if (this.entries.get(e.bic) === e && !e.removing) this.startLoop(e);
      }
      await this.heartbeat();
      if (oldKey && oldKey !== this.heartbeatKeyWritten) {
        await this.host.getConnection().del(oldKey).catch(() => {});
      }
    }).finally(() => {
      if (this.leaseChange === work) this.leaseChange = null;
    });
    this.leaseChange = work;
    this.chain = work;
  }

  /**
   * Stops the timers and the control tail, stops every tenant loop (in-flight
   * handlers finish and may ack), runs onTenantRemoved per tenant, deletes the
   * heartbeat and releases the consumer slot last.
   */
  async stopAll(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (
      const t of [this.reconcileTimer, this.heartbeatTimer, this.sweepTimer]
    ) {
      if (t) clearInterval(t);
    }
    this.reconcileTimer = this.heartbeatTimer = this.sweepTimer = null;
    for (const t of this.retryTimers.values()) clearTimeout(t);
    this.retryTimers.clear();
    if (this.tail) await this.tail.stop().catch(() => {});
    await this.chain.catch(() => {});
    const all = [...this.entries.values()];
    await Promise.all(all.map(async (e) => {
      e.removing = true;
      const h = e.handle;
      e.handle = null;
      if (h) await h.stop().catch(() => {});
    }));
    for (const e of all) {
      await this.callRemoved(e.bic);
      this.entries.delete(e.bic);
    }
    if (this.heartbeatKeyWritten) {
      await this.host.getConnection().del(this.heartbeatKeyWritten).catch(
        () => {},
      );
    }
    if (this.slot) await this.slot.release();
  }
}
