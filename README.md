# Redis Client Wrapper v2

A powerful and feature-rich Redis client wrapper for Deno applications with v2
API improvements. Built on top of `node-redis`, this library simplifies Redis
operations while adding advanced features like middleware support, metrics
collection, batch operations, and enhanced stream processing.

## Features

- 🔄 Redis Pub/Sub messaging system
- 📊 Enhanced Redis Streams with batch operations and dead letter queues
- 📝 Hash and String operations with middleware support
- 🔑 Flexible authentication with connection pooling
- 🔌 Automatic connection management with retry strategies
- 🚀 Event-driven architecture with metrics collection
- 💪 Full TypeScript support with type definitions
- 🎯 Fluent configuration API
- 📈 Built-in observability (metrics, health checks)
- 🔧 Middleware pipeline for cross-cutting concerns
- ⚡ Pipeline and transaction support
- 🔍 Advanced querying (scan, keys, mget/mset)

## Installation

```javascript
import { RedisClient } from "@nelreina/redis-client";
// TypeScript users get full type support automatically
```

## Usage

### Initialize Redis Client

```javascript
// Basic initialization
const redis = new RedisClient({
  redisHost: "localhost",
  redisPort: 6379,
  redisUser: "optional_username",
  redisPw: "optional_password",
  serviceName: "my-service",
  enableMetrics: true, // Enable metrics collection
  // reconnect: unbounded by default with capped backoff (0, 1 s, 2 s, 4 s … 30 s)
  connectionRetryDelay: 1000, // base delay, doubled per attempt
  connectionMaxDelay: 30000, // cap
  // connectionRetries: 3, // opt-in cap: give up after 3 attempts
  logger: customLogger, // Optional: pass custom logger
});

// Fluent configuration
const redis = new RedisClient({ redisHost: "localhost" })
  .withConnectionPool(5)
  .withRetries(3, 2000)
  .withMetrics(true)
  .withLogger(customLogger);

// Custom logger example
const customLogger = {
  info: (message, ...args) => console.log(`[INFO] ${message}`, ...args),
  error: (message, ...args) => console.error(`[ERROR] ${message}`, ...args),
  warn: (message, ...args) => console.warn(`[WARN] ${message}`, ...args),
  debug: (message, ...args) => console.debug(`[DEBUG] ${message}`, ...args),
};
```

### Pub/Sub Operations

Subscribe to a Redis channel:

```javascript
await redis.subscribe2RedisChannel("my-channel", (message) => {
  console.log("Received message:", message);
});
```

Publish to a Redis channel:

```javascript
await redis.publish2RedisChannel("my-channel", {
  event: "user-login",
  data: { userId: "123" },
});
```

### Redis Streams

Connect to an event stream with v2 configuration:

```javascript
// Simple usage (backward compatible)
await redis.connectToEventStream(
  "my-stream",
  (event) => {
    console.log("Stream event:", event);
  },
  true, // All events
);

// Advanced configuration
await redis.connectToEventStream("my-stream", {
  handler: (event) => console.log("Event:", event),
  events: ["user-registered", "order-created"], // Filter specific events
  startID: "$", // Start from latest
  consumer: "worker-1",
  group: "my-group",
  blockTimeout: 5000, // Block for 5s when reading
  autoAck: true, // Auto acknowledge messages
  retries: 3, // Retry failed messages 3 times
  deadLetterStream: "dlq:my-stream", // Send failed messages here
  metrics: true, // Enable stream metrics
});
```

Publish to a stream:

```javascript
// Single event
await redis.publishToStream(
  "my-stream",
  "user-registered",
  "user-123",
  { email: "user@example.com" },
);

// Batch publishing for better performance
await redis.publishBatchToStream("my-stream", [
  {
    event: "user-registered",
    aggregateId: "user-123",
    payload: { email: "user1@example.com" },
  },
  {
    event: "user-registered",
    aggregateId: "user-124",
    payload: { email: "user2@example.com" },
  },
]);
```

### Consumer loops with handles (0.11.0)

`startEventStream()` starts one consumer loop and returns a handle right away
(it does not wait for the loop). `done` resolves when the loop was stopped and
rejects when it failed (handler throw, Redis error, group creation failure).

```javascript
const handle = redis.startEventStream("ynohub:events:abcdcwcu", {
  handler: async (msg) => {
    // msg.streamKey, msg.streamId, msg.event, msg.payload, msg.deliveries (re-deliveries only)
    await msg.ack();
  },
  events: ["MAPPING_APPLIED"], // null = all events
  startId: "1761200000000-0", // group creation id (MKSTREAM) when the group is missing; default "$"
  consumerName: "yno-routing-1", // default: streamConsumerName
  blockMs: 5000,
  // passed through to @nelreina/redis-stream-event 0.11:
  drain: { maxDeliveries: 5 }, // PEL drain; parks entries delivered > 5 times
  autoClaim: { minIdleMs: 60000, everyMs: 60000 }, // XAUTOCLAIM at start + periodically
});
handle.clientId; // CLIENT ID of the loop's blocking connection
await handle.stop(); // CLIENT UNBLOCK, waits for the in-flight handler (it may ack), closes the connection
await handle.done;
```

`connectToEventStream()` keeps its signature and now delegates to
`startEventStream()` (it awaits `done`). `stopEventStreams()` stops every loop
the client started; `close()` does that first.

### Tailing a control stream

`tailStream()` reads a stream with plain `XREAD BLOCK` (no group, every replica
sees every entry) on a dedicated connection and resumes from the last handled
id, also across reconnects.

```javascript
const tail = redis.tailStream("ynohub:config:events", {
  fromId: "$", // or a concrete id
  blockMs: 5000,
  handler: (msg) => console.log(msg.id, msg.event, msg.payload),
  onTrimmed: (info) => resync(info), // entries after lastId may have been trimmed
});
tail.lastId;
await tail.stop();
```

### Stable consumer names: consumer slots

`claimConsumerSlot()` leases the lowest free
`ynohub:config:consumer-slot:<svc>:<n>` (`SET NX PX 30000`) and gives the
consumer name `<svc>-<n>`. The lease is renewed every 10 s with a fenced Lua
compare-and-renew (PEXPIRE only while the slot still holds this pod's name), so
two pods never renew each other's slot.

```javascript
const slot = await redis.claimConsumerSlot("yno-routing", {
  ttlMs: 30000,
  renewMs: 10000,
  keyPrefix: "ynohub:config:consumer-slot",
  podName: process.env.HOSTNAME, // default
  onLost: (newSlot) => {
    // another pod holds our slot now: stop consuming under slot.name,
    // then restart the loops under (await newSlot).name
  },
});
slot.name; // "yno-routing-1"
await slot.release(); // fenced DEL, after the loops have stopped
```

On a lost lease the slot first tries `SET NX` on the same key (lapsed but free →
nothing changes); only when another pod holds it is `onLost` called. An explicit
`CONSUMER_NAME` env wins over the lease (no key is written).

### Tenant streams: hot add/remove of tenants

`tenantStreams()` returns a `TenantStreamManager` that runs one consumer loop
per active tenant (`<streamPrefix>:<bic>`) and reconciles the set when
`CONFIG_CACHE_REFRESHED` arrives on the control stream, every `reconcileSec`
(backstop) and on retries. No restart is needed to add or remove a tenant.

```javascript
const tenants = redis.tenantStreams({
  streamPrefix: "ynohub:events", // STREAM env
  serviceName: "yno-routing", // group, slot and heartbeat name (default: client serviceName)
  events: ["MAPPING_APPLIED"],
  handler: eventHandler, // or handlerFor: (bic) => handler
  onTenantAdded: async (bic) => openTenantDb(bic), // throw → tenant degraded, retried 1 s … 60 s
  onTenantRemoved: async (bic) => closeTenantDb(bic),
  hotReload: "all",
  // defaults:
  // activeKey: "ynohub:config:host-banks:active", generationKey: "ynohub:config:cache:generation",
  // eventsStream: env CONFIG_EVENTS_STREAM ?? "ynohub:config:events",
  // activatedKeyPrefix: "ynohub:config:tenant-activated", appliedKeyPrefix: "ynohub:config:applied",
  // reconcileSec: env CONFIG_RECONCILE_SEC ?? 60, heartbeatSec: 30, blockMs: 5000
});
await tenants.start();
app.get("/health-check", (c) => c.json(tenants.status()));
process.on("SIGTERM", () => tenants.stopAll().then(() => process.exit(0)));
tenants.tenants(); // tenants whose onTenantAdded succeeded (e.g. for timers)
```

Behaviour:

| Step                                               | What happens                                                                                                                                         |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start()`                                          | claim consumer slot → remember the last control-stream id → `reconcile("boot")` → tail the control stream from that id → timers                      |
| reconcile                                          | serialized (a call during a run queues one rerun); reads `cache:status`, `cache:generation`, `host-banks:active` with one MGET                       |
| empty/missing active list                          | WARN, nothing is evicted                                                                                                                             |
| timer tick, generation unchanged, nothing to retry | heartbeat only (no generation key at all = legacy config-service → always a full diff)                                                               |
| generation lower than last seen                    | WARN "reset", full reconcile                                                                                                                         |
| tenant added                                       | group created at `GET tenant-activated:<bic>` (else `$`) **before** `onTenantAdded`; the loop starts **after** it                                    |
| `onTenantAdded` throws                             | tenant degraded (group already pinned, stream not consumed), retried with backoff 1 s … 60 s, reason in `status()` and the heartbeat                 |
| loop fails                                         | dropped and restarted with backoff (the PEL drain re-delivers the in-flight entry)                                                                   |
| tenant removed                                     | `stop()` (in-flight handler finishes) → `onTenantRemoved` → forgotten; group and PEL stay, so re-activation resumes                                  |
| lost slot lease                                    | all loops stop, new slot claimed, loops restart under the new name; if no slot can be claimed → `onFatal` (default exit 1)                           |
| heartbeat                                          | `HSET applied:<svc>:<consumerName> {generation, tenants, degraded, hotReload, consumerName, ts}` + `EXPIRE 120`, after each reconcile and every 30 s |
| `stopAll()`                                        | timers + tail stop, every loop stops, `onTenantRemoved` per tenant, heartbeat deleted, slot released last                                            |

Idle consumers of the group with an empty PEL (idle > 1 h, `sweepIdleMs`) are
removed with `XGROUP DELCONSUMER` when a tenant is added and every 10 min.

### Hash Operations

Set hash values:

```javascript
await redis.setHashValue("user:123", {
  name: "John Doe",
  email: "john@example.com",
  role: "admin",
});
```

Get all hash values from a set:

```javascript
const users = await redis.getAllSetHashValues("users");
```

### String Operations

Basic operations:

```javascript
// Get/Set with optional expiration
await redis.set("key", "value");
await redis.set("session:123", "data", { EX: 3600 }); // Expire in 1 hour
const value = await redis.get("key");

// Check existence and manage TTL
const exists = await redis.exists("key"); // Returns 1 if exists
await redis.expire("key", 300); // Expire in 5 minutes
const ttl = await redis.ttl("key"); // Get remaining TTL

// Delete keys
await redis.del("key"); // Delete single key
await redis.del(["key1", "key2", "key3"]); // Delete multiple

// Batch operations
const values = await redis.mget(["key1", "key2", "key3"]);
await redis.mset({
  "key1": "value1",
  "key2": "value2",
  "key3": "value3",
});
```

Set-based string operations:

```javascript
await redis.setStringValue("active-sessions", "session:123", "user-data");
const sessions = await redis.getAllStringValues("active-sessions");
await redis.clearStringValues("active-sessions");
```

### Advanced Operations

#### Scanning and Pattern Matching

```javascript
// Find all keys matching a pattern
const userKeys = await redis.keys("user:*");

// Scan keys efficiently (for large datasets)
for await (const keys of redis.scan("session:*", 100)) {
  console.log("Found keys:", keys);
}
```

#### Pipeline and Transactions

```javascript
// Pipeline for batch operations
const pipeline = redis.pipeline();
pipeline.get("key1");
pipeline.set("key2", "value2");
pipeline.incr("counter");
const results = await pipeline.exec();

// Transaction with watch
await redis.watch("balance");
const transaction = redis.transaction();
const balance = await redis.get("balance");
transaction.set("balance", parseInt(balance) - 100);
transaction.incr("transactions");
const results = await transaction.exec();
```

### Middleware Support

```javascript
// Add logging middleware
redis.use(async (operation, args, next) => {
  console.log(`Executing ${operation} with args:`, args);
  const start = Date.now();
  const result = await next();
  console.log(`${operation} took ${Date.now() - start}ms`);
  return result;
});

// Add authentication middleware
redis.use(async (operation, args, next) => {
  if (sensitiveOperations.includes(operation)) {
    await validateAuth();
  }
  return next();
});
```

### Observability

#### Health Checks

```javascript
const health = await redis.getHealth();
console.log(health);
// {
//   status: 'healthy',
//   connections: { main: true, pubsub: true },
//   timestamp: '2024-01-01T00:00:00.000Z'
// }

// Stream-specific health
const streamHealth = await redis.getStreamHealth("my-stream");
console.log(streamHealth);
// {
//   exists: true,
//   length: 1000,
//   groups: 2,
//   consumers: 5,
//   pending: 10
// }
```

#### Metrics

```javascript
// Enable metrics
const redis = new RedisClient({ enableMetrics: true });

// Get metrics
const metrics = redis.getMetrics();
console.log(metrics);
// {
//   operations: { total: 1000, successful: 995, failed: 5 },
//   latency: { avg: 2.5, p50: 2, p95: 5, p99: 10 },
//   connections: { active: 1, idle: 0, total: 1 },
//   streams: {
//     'my-stream': { published: 100, consumed: 95, errors: 2 }
//   }
// }

// Stream-specific metrics
const streamMetrics = redis.getStreamMetrics("my-stream");
```

## Error Handling

The client includes comprehensive error handling:

- Connection errors with automatic retry and backoff
- JSON parsing errors are caught and handled gracefully
- Middleware can intercept and handle errors
- Stream processing errors can be sent to dead letter queues
- All operations return detailed error information

## Upgrading to 0.11.0

- Depends on `@nelreina/redis-stream-event` 0.11.0: `subscribe()` now drains the
  consumer's own PEL first (parking entries delivered more than 5 times to
  `ynohub:parked:<group>`), claims idle entries with XAUTOCLAIM and acks through
  the main connection. Handlers see at-least-once delivery for entries that were
  in flight; see that package's MIGRATION.md.
- Reconnect is unbounded by default (capped exponential backoff, max 30 s).
  Before, the client gave up after 3 attempts (about 6 s). Pass
  `connectionRetries` to keep a cap.
- An event filter given as a string
  (`connectToEventStream(key, {handler}, "EVENT")`) now matches that event
  exactly; before it was a substring match.
- `close()` uses `quit()` (node-redis v4 has no `close()`) and stops the
  consumer loops first.
- New: `startEventStream`, `stopEventStreams`, `getEventStreamHandles`,
  `tailStream`, `claimConsumerSlot`, `tenantStreams` / `TenantStreamManager`,
  `ensureStreamGroup`, `sweepIdleConsumers`, `reconnectDelay`.

## Development

Integration tests need a Redis ≥ 6.2 on localhost:6379
(`REDIS_HOST`/`REDIS_PORT`); every test uses a `test:<random>:` prefix and
deletes its keys.

```bash
deno task test
```

## Migration from v1

The v2 API is mostly backward compatible. Key changes:

1. Stream configuration now supports an options object
2. New methods require explicit connection handling
3. Metrics and middleware are opt-in features
4. Some methods now return more detailed responses

## Best Practices

1. **Enable metrics in production** for monitoring and debugging
2. **Use pipelines** for batch operations to reduce network round trips
3. **Configure retry strategies** based on your reliability requirements
4. **Use middleware** for cross-cutting concerns like logging and auth
5. **Monitor stream health** to prevent backlogs and memory issues
6. **Use batch publishing** for high-throughput scenarios

## License

MIT

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

For more information or issues, please open an issue in the repository.
