# Redis Client Wrapper v2

A powerful and feature-rich Redis client wrapper for Deno applications with v2 API improvements.
Built on top of `node-redis`, this library simplifies Redis operations while adding advanced features
like middleware support, metrics collection, batch operations, and enhanced stream processing.

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
  connectionRetries: 3, // Retry connection 3 times
  connectionRetryDelay: 1000, // Wait 1s between retries
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
