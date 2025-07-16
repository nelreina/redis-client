# Redis Client Development Guide

This document provides guidelines for AI assistants working on this Redis client library.

## Project Overview

This is a Redis client wrapper for Deno that provides a simplified interface for Redis operations including Pub/Sub, Streams, Hash operations, and more. It's built on top of the `redis` npm package and includes TypeScript support.

## Project Structure

```
redis-client/
├── mod.ts           # Main module export with RedisClient class
├── deno.json        # Deno configuration and package metadata
├── README.md        # User-facing documentation
├── CLAUDE.md        # This file - AI assistant guidelines
└── examples/        # Example usage files (if any)
```

## Development Commands

### Testing
Currently, there are no test files in the project. When adding tests:
```bash
deno test
```

### Type Checking
```bash
deno check mod.ts
```

### Formatting
```bash
deno fmt
```

### Linting
```bash
deno lint
```

## Publishing to JSR

1. Ensure all changes are committed
2. Update version in `deno.json`
3. Update README.md if there are API changes
4. Publish to JSR:
   ```bash
   deno publish
   ```

## Key Development Guidelines

1. **Type Safety**: Always maintain full TypeScript type definitions
2. **Backward Compatibility**: The library maintains v1 compatibility while adding v2 features
3. **Error Handling**: All errors should be caught and logged appropriately
4. **Logger Interface**: The logger must implement `info`, `error`, `warn`, and `debug` methods
5. **Dependencies**: 
   - `redis`: npm package for Redis operations
   - `@nelreina/redis-stream-event`: JSR package for stream event handling

## Recent Changes

### v0.8.1
- Added support for custom logger in constructor via `logger` parameter
- Logger defaults to `console` if not provided
- Updated README with logger documentation

### v0.8.0
- Added multi-stream support
- Enhanced event interfaces with required headers field

## API Conventions

1. **Method Naming**: 
   - Pub/Sub methods use `2` (e.g., `subscribe2RedisChannel`)
   - Stream methods use descriptive names (e.g., `connectToEventStream`)
   - Standard operations use Redis command names (e.g., `get`, `set`, `hSet`)

2. **Error Handling**:
   - Connection errors trigger automatic retries
   - JSON parsing errors are caught and logged
   - Stream errors can be sent to dead letter queues

3. **Middleware**: 
   - Supports async middleware functions
   - Middleware receives operation name, arguments, and next function
   - Used for cross-cutting concerns like logging and metrics

## Future Considerations

- Add comprehensive test suite
- Consider adding more Redis data structure support (HyperLogLog, Bitmaps, etc.)
- Enhance metrics collection with more detailed breakdowns
- Add support for Redis Cluster
- Consider adding connection pooling for the main client (currently only pubsub is duplicated)

## Contributing

When making changes:
1. Update version in `deno.json` following semantic versioning
2. Update README.md if there are user-facing changes
3. Maintain backward compatibility where possible
4. Add JSDoc comments for all public methods
5. Run formatting and linting before committing