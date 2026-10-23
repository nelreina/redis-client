// Integration tests against a local Redis (REDIS_HOST/REDIS_PORT, default localhost:6379).
// Every test uses its own `test:<random>:` key prefix and deletes its keys.
import { assert, assertEquals } from "@std/assert";
import { createClient } from "redis";
import {
  reconnectDelay,
  RedisClient,
  type TenantStreamsOptions,
} from "../mod.ts";

const HOST = Deno.env.get("REDIS_HOST") ?? "localhost";
const PORT = Number(Deno.env.get("REDIS_PORT") ?? 6379);
const quiet = { info() {}, error() {}, warn() {}, debug() {} };

// deno-lint-ignore no-explicit-any
type Raw = any;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean | Promise<boolean>, ms = 8000) {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error("waitFor timed out");
    await sleep(25);
  }
}

async function setup() {
  const raw: Raw = createClient({ url: `redis://${HOST}:${PORT}` });
  await raw.connect();
  const prefix = `test:${crypto.randomUUID().slice(0, 8)}:`;
  const svc = `svc${crypto.randomUUID().slice(0, 6)}`;
  const clients: RedisClient[] = [];
  const mk = () => {
    const c = new RedisClient({
      redisHost: HOST,
      redisPort: PORT,
      serviceName: svc,
      logger: quiet,
    });
    clients.push(c);
    return c;
  };
  const cleanup = async () => {
    for (const c of clients) await c.close().catch(() => {});
    const keys: string[] = [];
    for await (const k of raw.scanIterator({ MATCH: `${prefix}*` })) {
      keys.push(k);
    }
    if (keys.length) await raw.del(keys);
    await raw.quit();
  };
  return { raw, prefix, svc, mk, cleanup };
}

function envelope(event: string, payload: unknown = {}) {
  return {
    event,
    aggregateId: "agg",
    timestamp: new Date().toISOString(),
    payload: JSON.stringify(payload),
    serviceName: "test",
    headers: "{}",
  };
}

function managerOpts(
  prefix: string,
  extra: Partial<TenantStreamsOptions> = {},
): TenantStreamsOptions {
  return {
    streamPrefix: `${prefix}events`,
    activeKey: `${prefix}host-banks:active`,
    generationKey: `${prefix}cache:generation`,
    statusKey: `${prefix}cache:status`,
    eventsStream: `${prefix}config:events`,
    activatedKeyPrefix: `${prefix}tenant-activated`,
    appliedKeyPrefix: `${prefix}applied`,
    slot: { keyPrefix: `${prefix}consumer-slot`, podName: "pod-a" },
    drain: { parkedStream: `${prefix}parked` },
    blockMs: 1000,
    sweepIdleMs: 0,
    logger: quiet,
    handler: async () => {},
    ...extra,
  };
}

async function groupNames(raw: Raw, key: string): Promise<string[]> {
  try {
    const groups = await raw.xInfoGroups(key);
    return groups.map((g: { name: string }) => g.name);
  } catch (_) {
    return [];
  }
}

Deno.test("reconnectDelay: unbounded capped backoff by default, opt-in cap", () => {
  assertEquals(reconnectDelay(0), 0);
  assertEquals(reconnectDelay(1), 1000);
  assertEquals(reconnectDelay(2), 2000);
  assertEquals(reconnectDelay(5), 16000);
  assertEquals(reconnectDelay(6), 30000);
  assertEquals(reconnectDelay(10_000), 30000);
  assert(reconnectDelay(4, { maxRetries: 3 }) instanceof Error);
  assertEquals(reconnectDelay(3, { maxRetries: 3 }), 4000);
});

Deno.test("claimConsumerSlot: two pods get -1/-2, fenced renew, lost lease moves to a new slot", async () => {
  const { raw, prefix, svc, mk, cleanup } = await setup();
  try {
    const a = mk(), b = mk();
    const keyPrefix = `${prefix}consumer-slot`;
    let lost: Promise<unknown> | null = null;
    const slotA = await a.claimConsumerSlot(svc, {
      keyPrefix,
      podName: "pod-a",
      ttlMs: 3000,
      renewMs: 150,
      onLost: (p) => (lost = p),
    });
    const slotB = await b.claimConsumerSlot(svc, {
      keyPrefix,
      podName: "pod-b",
      ttlMs: 3000,
      renewMs: 150,
    });
    assertEquals([slotA.name, slotA.n], [`${svc}-1`, 1]);
    assertEquals([slotB.name, slotB.n], [`${svc}-2`, 2]);
    assertEquals(await raw.get(`${keyPrefix}:${svc}:1`), "pod-a");
    assertEquals(await raw.get(`${keyPrefix}:${svc}:2`), "pod-b");

    // renew extends our own lease
    await raw.pExpire(`${keyPrefix}:${svc}:1`, 500);
    await sleep(400);
    assert(
      await raw.pTTL(`${keyPrefix}:${svc}:1`) > 1500,
      "own lease not renewed",
    );

    // lease lapsed and nobody took it: same slot is re-acquired, no onLost
    await raw.del(`${keyPrefix}:${svc}:1`);
    await waitFor(async () =>
      (await raw.get(`${keyPrefix}:${svc}:1`)) === "pod-a"
    );
    assertEquals(slotA.name, `${svc}-1`);
    assertEquals(lost, null);

    // another pod holds slot 1 now: the fenced renew must not extend it,
    // onLost fires and A moves to the lowest free slot (3)
    await raw.set(`${keyPrefix}:${svc}:1`, "pod-x", { PX: 1200 });
    await waitFor(() => lost !== null);
    const moved = await lost!;
    assertEquals(moved, slotA);
    assertEquals(slotA.name, `${svc}-3`);
    assertEquals(await raw.get(`${keyPrefix}:${svc}:3`), "pod-a");
    assert(
      await raw.pTTL(`${keyPrefix}:${svc}:1`) <= 1200,
      "foreign lease was extended",
    );
    assertEquals(await raw.get(`${keyPrefix}:${svc}:1`), "pod-x");

    // release is fenced: A deletes only its own slot
    await slotA.release();
    await slotB.release();
    assertEquals(await raw.get(`${keyPrefix}:${svc}:3`), null);
    assertEquals(await raw.get(`${keyPrefix}:${svc}:2`), null);
    assertEquals(await raw.get(`${keyPrefix}:${svc}:1`), "pod-x");
  } finally {
    await cleanup();
  }
});

Deno.test("claimConsumerSlot: CONSUMER_NAME env wins over the lease", async () => {
  const { raw, prefix, svc, mk, cleanup } = await setup();
  try {
    Deno.env.set("CONSUMER_NAME", `${svc}-7`);
    const slot = await mk().claimConsumerSlot(svc, {
      keyPrefix: `${prefix}consumer-slot`,
    });
    assertEquals([slot.name, slot.n, slot.leased], [`${svc}-7`, 7, false]);
    const keys: string[] = [];
    for await (const k of raw.scanIterator({ MATCH: `${prefix}*` })) {
      keys.push(k);
    }
    assertEquals(keys, []);
    await slot.release();
  } finally {
    Deno.env.delete("CONSUMER_NAME");
    await cleanup();
  }
});

Deno.test("tailStream: reads after fromId, resumes from lastId, reports trimming", async () => {
  const { raw, prefix, mk, cleanup } = await setup();
  try {
    const c = mk();
    const key = `${prefix}config:events`;
    const id1 = await raw.xAdd(key, "*", envelope("E1"));
    await raw.xAdd(key, "*", envelope("E2", { n: 2 }));
    const seen: string[] = [];
    let tail = c.tailStream(key, {
      fromId: id1,
      blockMs: 1000,
      handler: (m) => {
        seen.push(m.event!);
      },
    });
    await waitFor(() => seen.length === 1);
    await raw.xAdd(key, "*", envelope("E3"));
    await waitFor(() => seen.length === 2);
    assertEquals(seen, ["E2", "E3"]);
    const t0 = Date.now();
    await tail.stop();
    await tail.done;
    assert(Date.now() - t0 < 1500, "stop did not unblock the read");
    const lastId = tail.lastId;

    await raw.xAdd(key, "*", envelope("E4"));
    await raw.xAdd(key, "*", envelope("E5"));
    tail = c.tailStream(key, {
      fromId: lastId,
      blockMs: 1000,
      handler: (m) => {
        seen.push(m.event!);
      },
    });
    await waitFor(() => seen.length === 4);
    assertEquals(seen, ["E2", "E3", "E4", "E5"]);
    await tail.stop();

    // entries after fromId were trimmed away → onTrimmed
    await raw.xTrim(key, "MAXLEN", 1);
    let trimmed: unknown = null;
    tail = c.tailStream(key, {
      fromId: id1,
      blockMs: 1000,
      handler: () => {},
      onTrimmed: (info) => {
        trimmed = info;
      },
    });
    await waitFor(() => trimmed !== null);
    await tail.stop();
  } finally {
    await cleanup();
  }
});

Deno.test("startEventStream: handle with done/stop; connectToEventStream still works", async () => {
  const { raw, prefix, svc, mk, cleanup } = await setup();
  try {
    const c = mk();
    const key = `${prefix}events:s1`;
    const got: string[] = [];
    const h = c.startEventStream(key, {
      handler: async (m) => {
        got.push(`${m.streamKey}|${m.event}`);
        await m.ack();
      },
      events: ["WANTED"],
      startId: "0",
      consumerName: `${svc}-1`,
      blockMs: 1000,
      drain: { parkedStream: `${prefix}parked` },
    });
    await raw.xAdd(key, "*", envelope("OTHER"));
    await raw.xAdd(key, "*", envelope("WANTED"));
    await waitFor(() => got.length === 1);
    assertEquals(got, [`${key}|WANTED`]);
    assert(h.clientId > 0);
    assertEquals(c.getEventStreamHandles().length, 1);
    await h.stop();
    await h.done;
    assertEquals(h.running, false);
    assertEquals(c.getEventStreamHandles().length, 0);
    const consumers = await raw.xInfoConsumers(key, svc);
    assertEquals(consumers.map((x: { name: string }) => x.name), [`${svc}-1`]);

    // legacy API: resolves once the loop is stopped
    const key2 = `${prefix}events:s2`;
    let legacy = 0;
    const p = c.connectToEventStream(key2, {
      handler: async (m: { ack: () => Promise<number> }) => {
        legacy++;
        await m.ack();
      },
      blockMs: 1000,
      drain: { parkedStream: `${prefix}parked` },
    }, ["X"]);
    await waitFor(() => c.getEventStreamHandles().length === 1);
    await sleep(100);
    await raw.xAdd(key2, "*", envelope("X"));
    await waitFor(() => legacy === 1);
    await c.stopEventStreams();
    await p;
  } finally {
    await cleanup();
  }
});

Deno.test("tenantStreams: boot, hot add at activation id, hot remove keeps group, heartbeat", async () => {
  const { raw, prefix, svc, mk, cleanup } = await setup();
  try {
    const c = mk();
    const o = managerOpts(prefix);
    await raw.set(o.activeKey!, "AAA, bbb");
    await raw.set(o.generationKey!, "1");
    const got: string[] = [];
    const added: string[] = [];
    const removed: string[] = [];
    const groupAtAdd: Record<string, string[]> = {};
    const loopsAtAdd: Record<string, number> = {};
    const m = c.tenantStreams({
      ...o,
      handler: async (msg) => {
        got.push(`${msg.streamKey.split(":").pop()}:${msg.event}`);
        await msg.ack();
      },
      onTenantAdded: async (bic) => {
        groupAtAdd[bic] = await groupNames(raw, `${o.streamPrefix}:${bic}`);
        loopsAtAdd[bic] = c.getEventStreamHandles()
          .filter((h) => h.streamKey.endsWith(`:${bic}`)).length;
        added.push(bic);
      },
      onTenantRemoved: (bic) => {
        removed.push(bic);
      },
    });
    await m.start();
    assertEquals(m.tenants(), ["aaa", "bbb"]);
    assertEquals(m.consumerName, `${svc}-1`);
    // group created before onTenantAdded, loop started after it
    assertEquals(groupAtAdd, { aaa: [svc], bbb: [svc] });
    assertEquals(loopsAtAdd, { aaa: 0, bbb: 0 });

    await waitFor(() => c.getEventStreamHandles().every((h) => h.running));
    await sleep(100);
    await raw.xAdd(`${o.streamPrefix}:aaa`, "*", envelope("PING"));
    await waitFor(() => got.includes("aaa:PING"));

    // heartbeat
    const hb = await raw.hGetAll(`${o.appliedKeyPrefix}:${svc}:${svc}-1`);
    assertEquals(hb.generation, "1");
    assertEquals(hb.tenants, "aaa,bbb");
    assertEquals(hb.degraded, "{}");
    assertEquals(hb.hotReload, "all");
    assertEquals(hb.consumerName, `${svc}-1`);
    const ttl = await raw.ttl(`${o.appliedKeyPrefix}:${svc}:${svc}-1`);
    assert(ttl > 100 && ttl <= 120, `ttl ${ttl}`);

    // new tenant ccc activated at an id: older entries are not consumed
    await raw.xAdd(`${o.streamPrefix}:ccc`, "*", envelope("BEFORE"));
    const t = await raw.time();
    const activated = `${t.getTime()}-0`;
    await sleep(5);
    await raw.xAdd(`${o.streamPrefix}:ccc`, "*", envelope("AFTER"));
    await raw.set(`${o.activatedKeyPrefix}:ccc`, activated);
    await raw.set(o.activeKey!, "aaa,ccc");
    await raw.incr(o.generationKey!);
    await raw.xAdd(
      o.eventsStream!,
      "*",
      envelope("CONFIG_CACHE_REFRESHED", { generation: 2 }),
    );

    await waitFor(() => m.status().tenants.join() === "aaa,ccc");
    await waitFor(() => got.includes("ccc:AFTER"));
    assert(
      !got.includes("ccc:BEFORE"),
      "entry before the activation id was consumed",
    );
    assertEquals(removed, ["bbb"]);
    assertEquals(added, ["aaa", "bbb", "ccc"]);
    // removed tenant keeps its group (and PEL)
    assertEquals(await groupNames(raw, `${o.streamPrefix}:bbb`), [svc]);
    assertEquals(m.status().generation, 2);
    await waitFor(async () =>
      (await raw.hGet(`${o.appliedKeyPrefix}:${svc}:${svc}-1`, "tenants")) ===
        "aaa,ccc"
    );

    // the removed tenant's stream is not consumed anymore
    await raw.xAdd(`${o.streamPrefix}:bbb`, "*", envelope("LATE"));
    await sleep(300);
    assert(!got.includes("bbb:LATE"));

    await m.stopAll();
    assertEquals(c.getEventStreamHandles().length, 0);
    assertEquals(removed.sort(), ["aaa", "bbb", "ccc"]);
    assertEquals(await raw.exists(`${o.appliedKeyPrefix}:${svc}:${svc}-1`), 0);
    assertEquals(await raw.get(`${prefix}consumer-slot:${svc}:1`), null);
  } finally {
    await cleanup();
  }
});

Deno.test("tenantStreams: never evicts on an empty or missing active list", async () => {
  const { raw, prefix, mk, cleanup } = await setup();
  try {
    const c = mk();
    const o = managerOpts(prefix);
    await raw.set(o.activeKey!, "aaa,bbb");
    await raw.set(o.generationKey!, "5");
    const removed: string[] = [];
    const m = c.tenantStreams({
      ...o,
      onTenantRemoved: (b) => {
        removed.push(b);
      },
    });
    await m.start();
    await raw.set(o.activeKey!, " , ");
    await raw.incr(o.generationKey!);
    let r = await m.reconcile("manual");
    assertEquals(r.skipped, "empty-active-list");
    await raw.del(o.activeKey!);
    r = await m.reconcile("event");
    assertEquals(r.skipped, "empty-active-list");
    assertEquals(m.tenants(), ["aaa", "bbb"]);
    assertEquals(m.status().tenants, ["aaa", "bbb"]);
    assertEquals(removed, []);
    await m.stopAll();
  } finally {
    await cleanup();
  }
});

Deno.test("tenantStreams: legacy fleet without generation key reconciles on the timer; generation reset", async () => {
  const { raw, prefix, mk, cleanup } = await setup();
  try {
    const c = mk();
    const o = managerOpts(prefix, { reconcileSec: 0.3 });
    await raw.set(o.activeKey!, "aaa");
    const m = c.tenantStreams(o);
    await m.start();
    assertEquals(m.tenants(), ["aaa"]);
    await raw.set(o.activeKey!, "aaa,bbb");
    await waitFor(() => m.tenants().join() === "aaa,bbb");

    // generation present: unchanged timer ticks are no-ops, a reset reconciles
    await raw.set(o.generationKey!, "10");
    await waitFor(() => m.status().generation === 10);
    await raw.set(o.activeKey!, "bbb");
    await sleep(700);
    assertEquals(
      m.tenants(),
      ["aaa", "bbb"],
      "timer must not reconcile an unchanged generation",
    );
    await raw.set(o.generationKey!, "3");
    await waitFor(() => m.tenants().join() === "bbb");
    assertEquals(m.status().generation, 3);
    await m.stopAll();
  } finally {
    await cleanup();
  }
});

Deno.test("tenantStreams: degraded tenant gets the group, is retried with backoff, then consumes", async () => {
  const { raw, prefix, svc, mk, cleanup } = await setup();
  try {
    const c = mk();
    const o = managerOpts(prefix, { retryBaseMs: 300 });
    await raw.set(o.activeKey!, "aaa,ddd");
    await raw.set(o.generationKey!, "1");
    let failures = 0;
    const m = c.tenantStreams({
      ...o,
      onTenantAdded: (bic) => {
        if (bic === "ddd" && failures < 2) {
          failures++;
          const e = new Error('database "ddd" does not exist');
          // deno-lint-ignore no-explicit-any
          (e as any).code = "3D000";
          throw e;
        }
      },
    });
    await m.start();
    const st = m.status();
    assertEquals(st.status, "degraded");
    assertEquals(st.tenants, ["aaa"]);
    assertEquals(
      st.degraded.ddd.reason,
      '3D000: database "ddd" does not exist',
    );
    assertEquals(st.degraded.ddd.phase, "add");
    // group pinned although degraded
    assertEquals(await groupNames(raw, `${o.streamPrefix}:ddd`), [svc]);
    const hb = await raw.hGet(
      `${o.appliedKeyPrefix}:${svc}:${svc}-1`,
      "degraded",
    );
    assertEquals(JSON.parse(hb), {
      ddd: '3D000: database "ddd" does not exist',
    });

    await waitFor(() => m.status().tenants.join() === "aaa,ddd", 5000);
    assertEquals(failures, 2);
    assertEquals(m.status().status, "ok");
    await m.stopAll();
  } finally {
    await cleanup();
  }
});

Deno.test("tenantStreams: a failed tenant loop is restarted; lost lease restarts loops under a new name", async () => {
  const { raw, prefix, svc, mk, cleanup } = await setup();
  try {
    const c = mk();
    const o = managerOpts(prefix, {
      retryBaseMs: 200,
      slot: {
        keyPrefix: `${prefix}consumer-slot`,
        podName: "pod-a",
        ttlMs: 3000,
        renewMs: 150,
      },
    });
    await raw.set(o.activeKey!, "aaa");
    await raw.set(o.generationKey!, "1");
    let boom = true;
    const got: string[] = [];
    const m = c.tenantStreams({
      ...o,
      handler: async (msg) => {
        if (msg.event === "BOOM" && boom) {
          boom = false;
          throw new Error("handler failed");
        }
        got.push(`${msg.event}:${msg.deliveries ?? 1}`);
        await msg.ack();
      },
    });
    await m.start();
    await waitFor(() => c.getEventStreamHandles().some((h) => h.running));
    await sleep(100);
    await raw.xAdd(`${o.streamPrefix}:aaa`, "*", envelope("BOOM"));
    // loop dies, is restarted, the PEL drain re-delivers the entry
    await waitFor(() => got.includes("BOOM:2"));
    assertEquals(m.status().status, "ok");

    // another pod takes our slot: loops stop and restart as <svc>-2
    await raw.set(`${prefix}consumer-slot:${svc}:1`, "pod-x", { PX: 5000 });
    await waitFor(() => m.consumerName === `${svc}-2`);
    await waitFor(() =>
      c.getEventStreamHandles().some((h) =>
        h.consumerName === `${svc}-2` && h.running
      )
    );
    await sleep(100);
    await raw.xAdd(`${o.streamPrefix}:aaa`, "*", envelope("AFTER"));
    await waitFor(() => got.includes("AFTER:1"));
    const consumers = await raw.xInfoConsumers(`${o.streamPrefix}:aaa`, svc);
    const after = consumers.find((x: { name: string }) =>
      x.name === `${svc}-2`
    );
    assert(after, "new consumer name not registered");
    await waitFor(async () =>
      (await raw.exists(`${o.appliedKeyPrefix}:${svc}:${svc}-2`)) === 1
    );
    assertEquals(await raw.exists(`${o.appliedKeyPrefix}:${svc}:${svc}-1`), 0);
    await m.stopAll();
    assertEquals(await raw.get(`${prefix}consumer-slot:${svc}:1`), "pod-x");
    assertEquals(await raw.get(`${prefix}consumer-slot:${svc}:2`), null);
  } finally {
    await cleanup();
  }
});
