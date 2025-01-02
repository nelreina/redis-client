# Redis Client Wrapper

A lightweight and feature-rich Redis client wrapper for Deno applications that
simplifies Redis operations including Pub/Sub, Streams, Hash operations, and
more.

## Features

- 🔄 Redis Pub/Sub messaging system
- 📊 Redis Streams support
- 📝 Hash and String operations
- 🔑 Flexible authentication support
- 🔌 Automatic connection management
- 🚀 Event-driven architecture
- 💪 TypeScript/Deno support

## Installation

```javascript
import { RedisClient } from "./mod.js";
```

## Usage

### Initialize Redis Client

```javascript
const redis = new RedisClient({
  redisHost: "localhost",
  redisPort: 6379,
  redisUser: "optional_username",
  redisPw: "optional_password",
  serviceName: "my-service",
});
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

Connect to an event stream:

```javascript
await redis.connectToEventStream(
  "my-stream",
  (event) => {
    console.log("Stream event:", event);
  },
  true, // Enable events or pass an array of    events to filter , true is default means all events  e.g. [ "user-registered", "user-login" ]
);
```

Publish to a stream:

```javascript
await redis.publishToStream(
  "my-stream",
  "user-registered",
  "user-123",
  { email: "user@example.com" },
);
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

Set string value with set reference:

```javascript
await redis.setStringValue("active-sessions", "session:123", "user-data");
```

Get all string values from a set:

```javascript
const sessions = await redis.getAllStringValues("active-sessions");
```

Clear string values:

```javascript
await redis.clearStringValues("active-sessions");
```

## Error Handling

The client includes built-in error handling and logging:

- Connection errors are automatically logged
- JSON parsing errors are caught and handled
- Automatic reconnection attempts

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
