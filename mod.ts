import { createClient, type RedisClientType } from "redis";
import RedisStreamEvent from "@nelreina/redis-stream-event";

interface RedisClientConfig {
  redisHost: string;
  redisPort?: number;
  redisUser?: string;
  redisPw?: string;
  serviceName?: string;
  timeZone?: string;
  streamMaxLength?: number;
  streamConsumerName?: string;
  enableMetrics?: boolean;
  connectionRetries?: number;
  connectionRetryDelay?: number;
  poolSize?: number;
}

interface Logger {
  info: (message: string, ...args: any[]) => void;
  error: (message: string, ...args: any[]) => void;
  warn: (message: string, ...args: any[]) => void;
  debug: (message: string, ...args: any[]) => void;
}

type MiddlewareFunction = (
  operation: string,
  args: any[],
  next: () => Promise<any>
) => Promise<any>;

interface Metrics {
  operations: {
    total: number;
    successful: number;
    failed: number;
  };
  latency: {
    values: number[];
  };
  streams: Record<string, {
    published: number;
    consumed: number;
    errors: number;
  }>;
}

interface StreamMetrics {
  published: number;
  consumed: number;
  errors: number;
  processingTimes: number[];
}

/**
 * Redis client wrapper class that provides simplified Redis operations
 * including Pub/Sub, Streams, Hash operations, and more.
 * Now with v2 API improvements including fluent configuration, batch operations,
 * middleware support, and enhanced observability.
 */
export class RedisClient {
  private url: string | undefined;
  private serviceName: string;
  private timeZone: string;
  private streamMaxLength: number;
  private streamConsumerName: string;
  private enableMetrics: boolean;
  private connectionRetries: number;
  private connectionRetryDelay: number;
  private poolSize: number;
  private middleware: MiddlewareFunction[];
  private logger: Logger;
  private metrics: Metrics;
  private client: RedisClientType;
  private pubsub: RedisClientType;
  private eventStream: RedisStreamEvent | null;
  private streamMetrics: Map<string, StreamMetrics>;

  /**
   * Creates a new Redis client instance
   * @param {Object} config - Configuration object
   * @param {string} config.redisHost - Redis host address
   * @param {number} [config.redisPort=6379] - Redis port number
   * @param {string} [config.redisUser] - Redis username for authentication
   * @param {string} [config.redisPw] - Redis password for authentication
   * @param {string} [config.serviceName="NO-NAME"] - Service identifier
   * @param {string} [config.timeZone="America/Curacao"] - Timezone for event timestamps
   * @param {number} [config.streamMaxLength=10000] - Maximum length of the stream
   * @param {string} [config.streamConsumerName="consumer-1"] - Name of the stream consumer
   */
  constructor(config: RedisClientConfig) {
    const {
      redisHost,
      redisPort = 6379,
      redisUser,
      redisPw,
      serviceName = "NO-NAME",
      timeZone = "America/Curacao",
      streamMaxLength = 10000,
      streamConsumerName = "consumer-1",
      enableMetrics = false,
      connectionRetries = 3,
      connectionRetryDelay = 1000,
      poolSize = 1,
    } = config;
    this.url = this.buildRedisUrl(redisHost, redisPort, redisUser, redisPw);
    this.serviceName = serviceName;
    this.timeZone = timeZone;
    this.streamMaxLength = streamMaxLength;
    this.streamConsumerName = streamConsumerName;
    this.enableMetrics = enableMetrics;
    this.connectionRetries = connectionRetries;
    this.connectionRetryDelay = connectionRetryDelay;
    this.poolSize = poolSize;
    
    this.middleware = [];
    this.logger = console;
    this.metrics = {
      operations: { total: 0, successful: 0, failed: 0 },
      latency: { values: [] },
      streams: {}
    };
    
    this.client = createClient({ 
      url: this.url, 
      name: this.serviceName,
      socket: {
        reconnectStrategy: (retries) => {
          if (retries > this.connectionRetries) {
            return new Error('Max retries reached');
          }
          return Math.min(retries * this.connectionRetryDelay, 5000);
        }
      }
    });
    
    this.pubsub = this.client.duplicate();
    this.eventStream = null;
    this.streamMetrics = new Map();
    
    this.client.on("connect", () => {
      this.logger.info(`✅ Connected to redis: ${redisHost}`);
    });

    this.client.on("error", (error) => {
      this.logger.error(`❌ Error connecting to redis: ${this.url}`);
      this.logger.error(error);
    });
    
    if (!this.client.isOpen) this.client.connect();
  }

  /**
   * Builds Redis connection URL from components
   * @private
   * @param {string} host - Redis host address
   * @param {number} port - Redis port number
   * @param {string} [user] - Redis username
   * @param {string} [password] - Redis password
   * @returns {string|undefined} Formatted Redis URL or undefined
   */
  buildRedisUrl(host: string, port: number, user?: string, password?: string): string | undefined {
    if (!host) return undefined;

    let url = "redis://";
    if (user && password) {
      url += `${user}:${password}@`;
    }
    url += `${host}:${port}`;
    return url;
  }

  /**
   * Subscribes to a Redis channel
   * @param {string} channel - Channel name to subscribe to
   * @param {(payload: any) => void} callback - Callback function to handle received messages
   * @returns {Promise<void>}
   */
  async subscribe2RedisChannel(channel: string, callback: (payload: any) => void): Promise<void> {
    if (!this.pubsub.isOpen) await this.pubsub.connect();
    return this.executeWithMiddleware('subscribe', [channel], async () => {
      return this.trackMetrics('subscribe', async () => {
        await this.pubsub.subscribe(channel, (payload) => {
          try {
            callback(JSON.parse(payload));
          } catch (error) {
            callback(payload);
            this.logger.error((error as Error).message);
          }
        });
        this.logger.info(`✅ Subscribed to redis channel: ${channel}`);
      });
    });
  }

  /**
   * Publishes a message to a Redis channel
   * @param {string} channel - Channel name to publish to
   * @param {any} payload - Message payload to publish
   * @returns {Promise<number>} Number of clients that received the message
   */
  async publish2RedisChannel(channel: string, payload: any): Promise<number> {
    if (!this.pubsub.isOpen) await this.pubsub.connect();
    return this.executeWithMiddleware('publish', [channel, payload], async () => {
      return this.trackMetrics('publish', async () => {
        let message;
        try {
          message = JSON.stringify(payload);
        } catch (error) {
          message = payload;
          this.logger.error((error as Error).message);
        }
        return await this.pubsub.publish(channel, message);
      });
    });
  }

  /**
   * Sets multiple hash fields to multiple values
   * @param {string} key - Hash key
   * @param {Object.<string, any>} object - Object containing field-value pairs
   * @returns {Promise<number>} Number of fields that were added
   */
  async setHashValue(key: string, object: Record<string, any>): Promise<number> {
    if (!this.client.isOpen) await this.client.connect();
    const values = Object.entries(object).reduce((acc: any[], [key, value]) => {
      acc.push(key);
      acc.push(value);
      return acc;
    }, []);
    return this.executeWithMiddleware('hSet', [key, object], () => 
      this.trackMetrics('hSet', () => this.client.hSet(key, values))
    );
  }

  /**
   * Retrieves all hash values from a set
   * @param {string} key - Set key containing hash keys
   * @returns {Promise<Array<Object>>} Array of hash objects with their values
   */
  async getAllSetHashValues(key: string): Promise<Array<Record<string, any>>> {
    if (!this.client.isOpen) await this.client.connect();
    return this.executeWithMiddleware('getAllSetHashValues', [key], async () => {
      return this.trackMetrics('getAllSetHashValues', async () => {
        const keys = await this.client.sMembers(key);
        const values = [];
        for (const key of keys) {
          const data = { event: key, ...(await this.client.hGetAll(key)) };
          values.push(data);
        }
        return values;
      });
    });
  }

  /**
   * Sets a string value and adds it to a set
   * @param {string} setKey - Set key to add the string key to
   * @param {string} key - String key
   * @param {string} value - String value
   * @returns {Promise<boolean>} Operation success status
   */
  async setStringValue(setKey: string, key: string, value: string): Promise<boolean> {
    if (!this.client.isOpen) await this.client.connect();
    return this.executeWithMiddleware('setStringValue', [setKey, key, value], async () => {
      return this.trackMetrics('setStringValue', async () => {
        await this.client.set(key, value);
        await this.client.sAdd(setKey, key);
        return true;
      });
    });
  }

  /**
   * Retrieves all string values from keys in a set
   * @param {string} setKey - Set key containing string keys
   * @returns {Promise<Array<string|null>>} Array of string values
   */
  async getAllStringValues(setKey: string): Promise<Array<string | null>> {
    if (!this.client.isOpen) await this.client.connect();
    return this.executeWithMiddleware('getAllStringValues', [setKey], async () => {
      return this.trackMetrics('getAllStringValues', async () => {
        const keys = await this.client.sMembers(setKey);
        const values = [];
        for (const key of keys) {
          values.push(await this.client.get(key));
        }
        return values;
      });
    });
  }

  /**
   * Clears all string values referenced by keys in a set
   * @param {string} setKey - Set key containing string keys
   * @returns {Promise<boolean>} Operation success status
   */
  async clearStringValues(setKey: string): Promise<boolean> {
    if (!this.client.isOpen) await this.client.connect();
    return this.executeWithMiddleware('clearStringValues', [setKey], async () => {
      return this.trackMetrics('clearStringValues', async () => {
        const keys = await this.client.sMembers(setKey);
        for (const key of keys) {
          await this.client.del(key);
        }
        return true;
      });
    });
  }

  /**
   * Gets or creates a Redis Stream Event instance
   * @param {string|string[]} streamKeyName - Stream key name or array of stream key names
   * @param {Object} [streamOptions={}] - Stream configuration options
   * @returns {RedisStreamEvent} Redis Stream Event instance
   */
  getEventStream(streamKeyName: string | string[], streamOptions: any = {}): RedisStreamEvent {
    const options = {
      timeZone: this.timeZone,
      maxLength: this.streamMaxLength,
      consumer: this.streamConsumerName,
      ...streamOptions
    };
    
    return new RedisStreamEvent(
      this.client as any,
      streamKeyName,
      this.serviceName,
      options,
    );
  }

  /**
   * Connects to a Redis Stream and sets up event handling
   * @param {string} streamKeyName - Stream key name
   * @param {Object|((event: any) => void|Promise<void>)} [options={}] - Configuration options or handler function
   * @param {boolean|Array<string>} [events=false] - Events to filter (true for all events)
   * @param {string} [startID="$"] - Start ID for the stream
   * @returns {Promise<void>}
   */
  async connectToEventStream(
    streamKeyName: string,
    options: any = {},
    events: boolean | string[] = false,
    startID: string = "$",
  ): Promise<void> {
    let handler;
    let streamOptions = {
      timeZone: this.timeZone,
      maxLength: this.streamMaxLength,
      consumer: this.streamConsumerName,
      startID,
    };

    if (typeof options === 'function') {
      handler = options;
    } else {
      handler = options.handler || ((str: any) => console.info(str));
      streamOptions = {
        ...streamOptions,
        ...options,
        startID: options.startID || startID,
      };
      events = options.events !== undefined ? options.events : events;
    }

    this.eventStream = this.getEventStream(streamKeyName, streamOptions);

    if (!this.client.isOpen) await this.client.connect();
    
    const wrappedHandler = async (event: any) => {
      const start = Date.now();
      try {
        await handler(event);
        if (this.enableMetrics) {
          if (!this.metrics.streams[streamKeyName]) {
            this.metrics.streams[streamKeyName] = { published: 0, consumed: 0, errors: 0 };
          }
          this.metrics.streams[streamKeyName].consumed++;
          
          if (!this.streamMetrics.has(streamKeyName)) {
            this.streamMetrics.set(streamKeyName, {
              published: 0,
              consumed: 0,
              errors: 0,
              processingTimes: []
            });
          }
          const metrics = this.streamMetrics.get(streamKeyName);
          if (metrics) {
            metrics.consumed++;
            metrics.processingTimes.push(Date.now() - start);
            if (metrics.processingTimes.length > 100) {
              metrics.processingTimes.shift();
            }
          }
        }
      } catch (error) {
        if (this.enableMetrics) {
          if (!this.metrics.streams[streamKeyName]) {
            this.metrics.streams[streamKeyName] = { published: 0, consumed: 0, errors: 0 };
          }
          this.metrics.streams[streamKeyName].errors++;
        }
        throw error;
      }
    };
    
    const stream = await (this.eventStream as any).createStream(
      streamKeyName,
      this.serviceName,
    );
    await stream.subscribe(wrappedHandler, events as any);
  }

  /**
   * Connects to multiple Redis Streams and sets up event handling
   * @param {string[]} streamKeyNames - Array of stream key names
   * @param {Object|((event: any) => void|Promise<void>)} [options={}] - Configuration options or handler function
   * @param {boolean|Array<string>} [events=false] - Events to filter (true for all events)
   * @param {string} [startID="$"] - Start ID for the stream
   * @returns {Promise<void>}
   */
  async connectToMultipleEventStreams(
    streamKeyNames: string[],
    options: any = {},
    events: boolean | string[] = false,
    startID: string = "$",
  ): Promise<void> {
    let handler;
    let streamOptions = {
      timeZone: this.timeZone,
      maxLength: this.streamMaxLength,
      consumer: this.streamConsumerName,
      startID,
    };

    if (typeof options === 'function') {
      handler = options;
    } else {
      handler = options.handler || ((str: any) => console.info(str));
      streamOptions = {
        ...streamOptions,
        ...options,
        startID: options.startID || startID,
      };
      events = options.events !== undefined ? options.events : events;
    }

    this.eventStream = this.getEventStream(streamKeyNames, streamOptions);

    if (!this.client.isOpen) await this.client.connect();
    
    const stream = await (this.eventStream as any).createStream();
    await stream.subscribe(handler, events as any);
  }

  /**
   * Publishes an event to a Redis Stream
   * @param {string} streamKeyName - Stream key name
   * @param {string} event - Event type
   * @param {string} aggregateId - Aggregate identifier
   * @param {Record<string, string>} headers - Required headers
   * @param {any} payload - Event payload
   * @returns {Promise<void>}
   */
  async publishToStream(streamKeyName: string, event: string, aggregateId: string, headers: Record<string, string>, payload: any): Promise<void> {
    if (!this.client.isOpen) await this.client.connect();
    const eventStream = this.getEventStream(streamKeyName);
    
    try {
      await eventStream.publish(event, aggregateId, payload, headers, streamKeyName);
      if (this.enableMetrics) {
        if (!this.metrics.streams[streamKeyName]) {
          this.metrics.streams[streamKeyName] = { published: 0, consumed: 0, errors: 0 };
        }
        this.metrics.streams[streamKeyName].published++;
        
        if (!this.streamMetrics.has(streamKeyName)) {
          this.streamMetrics.set(streamKeyName, {
            published: 0,
            consumed: 0,
            errors: 0,
            processingTimes: []
          });
        }
        const metrics = this.streamMetrics.get(streamKeyName);
        if (metrics) {
          metrics.published++;
        }
      }
    } catch (error) {
      if (this.enableMetrics) {
        if (!this.metrics.streams[streamKeyName]) {
          this.metrics.streams[streamKeyName] = { published: 0, consumed: 0, errors: 0 };
        }
        this.metrics.streams[streamKeyName].errors++;
      }
      throw error;
    }
  }

  /**
   * Gets a value by key from Redis
   * @param {string} key - Key to retrieve
   * @returns {Promise<string|null>} Value associated with the key
   */
  async get(key: string): Promise<string | null> {
    if (!this.client.isOpen) await this.client.connect();
    return this.executeWithMiddleware('get', [key], () => 
      this.trackMetrics('get', () => this.client.get(key))
    );
  }

  /**
   * Sets a value by key from Redis
   * @param {string} key - Key to retrieve
   * @param {string} value - Value to set
   * @param {Object} [options] - Optional settings like expiration
   * @returns {Promise<string|null>} Value associated with the key
   */
  async set(key: string, value: string, options?: any): Promise<string | null> {
    if (!this.client.isOpen) await this.client.connect();
    return this.executeWithMiddleware('set', [key, value, options], () => 
      this.trackMetrics('set', () => 
        options ? this.client.set(key, value, options) : this.client.set(key, value)
      )
    );
  }

  /**
   * Closes the Redis client connection
   * @returns {Promise<void>}
   */
  async close(): Promise<void> {
    if (this.client.isOpen) {
      await (this.client as any).close();
      this.logger.info("✅ Redis client connection closed");
    }

    if (this.pubsub.isOpen) {
      await (this.pubsub as any).close();
      this.logger.info("✅ Redis pubsub connection closed");
    }
  }

  /**
   * Increments a value by a specified amount
   * @param {string} key - Key to increment
   * @param {number} value - Amount to increment by
   * @returns {Promise<number>} New value after increment
   */
  async incrBy(key: string, value: number): Promise<number> {
    if (!this.client.isOpen) await this.client.connect();
    return this.executeWithMiddleware('incrBy', [key, value], () => 
      this.trackMetrics('incrBy', () => this.client.incrBy(key, value))
    );
  }

  /**
   * Gets the Redis client connection
   * To execute Redis commands directly
   * @returns {RedisClientType} Redis client connection
   */
  getConnection(): RedisClientType {
    return this.client;
  }

  /**
   * Configure connection pool size
   * @param {number} size - Connection pool size
   * @returns {RedisClient} This instance for chaining
   */
  withConnectionPool(size: number): RedisClient {
    this.poolSize = size;
    return this;
  }

  /**
   * Configure retry settings
   * @param {number} retries - Number of retries
   * @param {number} [delay=1000] - Delay between retries in milliseconds
   * @returns {RedisClient} This instance for chaining
   */
  withRetries(retries: number, delay: number = 1000): RedisClient {
    this.connectionRetries = retries;
    this.connectionRetryDelay = delay;
    return this;
  }

  /**
   * Enable or disable metrics collection
   * @param {boolean} [enabled=true] - Whether to enable metrics
   * @returns {RedisClient} This instance for chaining
   */
  withMetrics(enabled: boolean = true): RedisClient {
    this.enableMetrics = enabled;
    return this;
  }

  /**
   * Set custom logger
   * @param {{info: Function, error: Function, warn: Function, debug: Function}} logger - Logger instance with info, error, warn, debug methods
   * @returns {RedisClient} This instance for chaining
   */
  withLogger(logger: Logger): RedisClient {
    this.logger = logger;
    return this;
  }

  /**
   * Add middleware function
   * @param {(operation: string, args: any[], next: () => Promise<any>) => Promise<any>} middleware - Middleware function
   * @returns {RedisClient} This instance for chaining
   */
  use(middleware: MiddlewareFunction): RedisClient {
    this.middleware.push(middleware);
    return this;
  }

  /**
   * Execute operation with middleware chain
   * @private
   * @param {string} operation - Operation name
   * @param {Array<any>} args - Operation arguments
   * @param {() => Promise<any>} fn - Function to execute
   * @returns {Promise<any>} Operation result
   */
  private async executeWithMiddleware(operation: string, args: any[], fn: () => Promise<any>): Promise<any> {
    if (!this.middleware.length) {
      return fn();
    }

    let index = -1;
    const dispatch = async (i: number): Promise<any> => {
      if (i <= index) throw new Error('next() called multiple times');
      index = i;
      let fn: any = this.middleware[i];
      if (i === this.middleware.length) fn = async () => fn();
      if (!fn) return;
      return fn(operation, args, () => dispatch(i + 1));
    };

    return dispatch(0);
  }

  /**
   * Track metrics for operations
   * @private
   * @param {string} operation - Operation name
   * @param {() => Promise<any>} fn - Function to track
   * @returns {Promise<any>} Function result
   */
  private async trackMetrics(operation: string, fn: () => Promise<any>): Promise<any> {
    if (!this.enableMetrics) return fn();
    
    const start = Date.now();
    this.metrics.operations.total++;
    
    try {
      const result = await fn();
      this.metrics.operations.successful++;
      const duration = Date.now() - start;
      this.metrics.latency.values.push(duration);
      if (this.metrics.latency.values.length > 1000) {
        this.metrics.latency.values.shift();
      }
      return result;
    } catch (error) {
      this.metrics.operations.failed++;
      throw error;
    }
  }

  /**
   * Check if key exists
   * @param {string|string[]} key - Key(s) to check
   * @returns {Promise<number>} Number of keys that exist
   */
  async exists(key: string | string[]): Promise<number> {
    if (!this.client.isOpen) await this.client.connect();
    return this.executeWithMiddleware('exists', [key], () => 
      this.trackMetrics('exists', () => this.client.exists(key))
    );
  }

  /**
   * Delete key(s)
   * @param {string|string[]} key - Key(s) to delete
   * @returns {Promise<number>} Number of keys deleted
   */
  async del(key: string | string[]): Promise<number> {
    if (!this.client.isOpen) await this.client.connect();
    const keys = Array.isArray(key) ? key : [key];
    return this.executeWithMiddleware('del', keys, () => 
      this.trackMetrics('del', () => this.client.del(keys))
    );
  }

  /**
   * Set key expiration
   * @param {string} key - Key to expire
   * @param {number} seconds - Seconds until expiration
   * @returns {Promise<boolean>} True if expiration was set
   */
  async expire(key: string, seconds: number): Promise<boolean> {
    if (!this.client.isOpen) await this.client.connect();
    return this.executeWithMiddleware('expire', [key, seconds], () => 
      this.trackMetrics('expire', () => this.client.expire(key, seconds))
    );
  }

  /**
   * Get time to live for key
   * @param {string} key - Key to check
   * @returns {Promise<number>} TTL in seconds, -2 if key doesn't exist, -1 if no TTL
   */
  async ttl(key: string): Promise<number> {
    if (!this.client.isOpen) await this.client.connect();
    return this.executeWithMiddleware('ttl', [key], () => 
      this.trackMetrics('ttl', () => this.client.ttl(key))
    );
  }

  /**
   * Scan keys matching pattern
   * @param {string} pattern - Pattern to match
   * @param {number} [count=100] - Hint for number of keys per iteration
   * @returns {AsyncGenerator<string[], void, unknown>} Async generator of key arrays
   */
  async *scan(pattern: string, count: number = 100): AsyncGenerator<string[], void, unknown> {
    if (!this.client.isOpen) await this.client.connect();
    let cursor = 0;
    do {
      const result = await this.client.scan(cursor as any, {
        MATCH: pattern,
        COUNT: count
      });
      cursor = result.cursor;
      yield result.keys as string[];
    } while (cursor !== 0);
  }

  /**
   * Get multiple keys at once
   * @param {string[]} keys - Array of keys to get
   * @returns {Promise<Array<string|null>>} Array of values
   */
  async mget(keys: string[]): Promise<Array<string | null>> {
    if (!this.client.isOpen) await this.client.connect();
    return this.executeWithMiddleware('mget', [keys], () => 
      this.trackMetrics('mget', () => this.client.mGet(keys))
    );
  }

  /**
   * Set multiple key-value pairs
   * @param {Object.<string, string>} keyValuePairs - Object with key-value pairs
   * @returns {Promise<string>} OK on success
   */
  async mset(keyValuePairs: Record<string, string>): Promise<string> {
    if (!this.client.isOpen) await this.client.connect();
    const args = [];
    for (const [key, value] of Object.entries(keyValuePairs)) {
      args.push(key, value);
    }
    return this.executeWithMiddleware('mset', [keyValuePairs], () => 
      this.trackMetrics('mset', () => this.client.mSet(keyValuePairs))
    );
  }

  /**
   * Find all keys matching pattern
   * @param {string} pattern - Pattern to match
   * @returns {Promise<string[]>} Array of matching keys
   */
  async keys(pattern: string): Promise<string[]> {
    if (!this.client.isOpen) await this.client.connect();
    return this.executeWithMiddleware('keys', [pattern], () => 
      this.trackMetrics('keys', () => this.client.keys(pattern))
    );
  }

  /**
   * Flush current database
   * @param {boolean} [force=false] - Must be true to execute
   * @returns {Promise<string>} OK on success
   * @throws {Error} If force is not true
   */
  async flushdb(force: boolean = false): Promise<string> {
    if (!this.client.isOpen) await this.client.connect();
    if (!force) {
      throw new Error('flushdb requires force=true to prevent accidental data loss');
    }
    return this.executeWithMiddleware('flushdb', [], () => 
      this.trackMetrics('flushdb', () => this.client.flushDb())
    );
  }

  /**
   * Get Redis server information
   * @param {string} [section] - Specific section to retrieve
   * @returns {Promise<string>} Server information
   */
  async info(section?: string): Promise<string> {
    if (!this.client.isOpen) await this.client.connect();
    return this.executeWithMiddleware('info', [section], () => 
      this.trackMetrics('info', () => 
        section ? this.client.info(section) : this.client.info()
      )
    );
  }

  /**
   * Ping Redis server
   * @returns {Promise<string>} PONG response
   */
  async ping(): Promise<string> {
    if (!this.client.isOpen) await this.client.connect();
    return this.executeWithMiddleware('ping', [], () => 
      this.trackMetrics('ping', () => this.client.ping())
    );
  }

  /**
   * Create pipeline for batch operations
   * @returns {{get: Function, set: Function, del: Function, exists: Function, expire: Function, ttl: Function, incr: Function, incrBy: Function, hSet: Function, hGet: Function, hGetAll: Function, sAdd: Function, sMembers: Function, sRem: Function, exec: Function}} Pipeline command object
   */
  pipeline(): any {
    const multi = this.client.multi();
    return {
      /** @param {string} key @returns {void} */
      get: (key: string) => multi.get(key),
      /** @param {string} key @param {string} value @param {Object} [options] @returns {void} */
      set: (key: string, value: string, options?: any) => options ? multi.set(key, value, options) : multi.set(key, value),
      /** @param {string|string[]} key @returns {void} */
      del: (key: string | string[]) => multi.del(key),
      /** @param {string|string[]} key @returns {void} */
      exists: (key: string | string[]) => multi.exists(key),
      /** @param {string} key @param {number} seconds @returns {void} */
      expire: (key: string, seconds: number) => multi.expire(key, seconds),
      /** @param {string} key @returns {void} */
      ttl: (key: string) => multi.ttl(key),
      /** @param {string} key @returns {void} */
      incr: (key: string) => multi.incr(key),
      /** @param {string} key @param {number} increment @returns {void} */
      incrBy: (key: string, increment: number) => multi.incrBy(key, increment),
      /** @param {string} key @param {string} field @param {string} value @returns {void} */
      hSet: (key: string, field: string, value: string) => multi.hSet(key, field, value),
      /** @param {string} key @param {string} field @returns {void} */
      hGet: (key: string, field: string) => multi.hGet(key, field),
      /** @param {string} key @returns {void} */
      hGetAll: (key: string) => multi.hGetAll(key),
      /** @param {string} key @param {string|string[]} member @returns {void} */
      sAdd: (key: string, member: string | string[]) => multi.sAdd(key, member),
      /** @param {string} key @returns {void} */
      sMembers: (key: string) => multi.sMembers(key),
      /** @param {string} key @param {string|string[]} member @returns {void} */
      sRem: (key: string, member: string | string[]) => multi.sRem(key, member),
      /** @returns {Promise<any[]>} */
      exec: () => this.trackMetrics('pipeline', () => multi.exec())
    };
  }

  /**
   * Create transaction
   * @returns {{get: Function, set: Function, del: Function, exists: Function, expire: Function, ttl: Function, incr: Function, incrBy: Function, hSet: Function, hGet: Function, hGetAll: Function, sAdd: Function, sMembers: Function, sRem: Function, exec: Function, watch: Function, unwatch: Function, discard: Function}} Transaction command object
   */
  transaction(): any {
    const multi = this.client.multi();
    return {
      ...this.pipeline(),
      /** @param {string|string[]} keys @returns {Promise<string>} */
      watch: (keys: string | string[]) => this.client.watch(Array.isArray(keys) ? keys : [keys]),
      /** @returns {Promise<string>} */
      unwatch: () => this.client.unwatch(),
      /** @returns {string} */
      discard: () => multi.discard()
    };
  }

  /**
   * Watch keys for changes
   * @param {string|string[]} keys - Key(s) to watch
   * @returns {Promise<string>} OK on success
   */
  async watch(keys: string | string[]): Promise<string> {
    if (!this.client.isOpen) await this.client.connect();
    return this.client.watch(Array.isArray(keys) ? keys : [keys]);
  }

  /**
   * Batch publishing to streams
   * @param {string} streamKeyName - Stream key name
   * @param {Array<{event: string, aggregateId: string, payload: any, headers: Record<string, string>}>} events - Array of events to publish
   * @returns {Promise<Array<{success: boolean, event?: any, error?: string}>>} Results for each event
   */
  async publishBatchToStream(streamKeyName: string, events: Array<{event: string, aggregateId: string, payload: any, headers: Record<string, string>}>): Promise<Array<{success: boolean, event?: any, error?: string}>> {
    if (!this.client.isOpen) await this.client.connect();
    const eventStream = this.getEventStream(streamKeyName);
    
    const results = [];
    for (const event of events) {
      try {
        await eventStream.publish(event.event, event.aggregateId, event.payload, event.headers);
        results.push({ success: true, event });
        if (this.enableMetrics) {
          if (!this.metrics.streams[streamKeyName]) {
            this.metrics.streams[streamKeyName] = { published: 0, consumed: 0, errors: 0 };
          }
          this.metrics.streams[streamKeyName].published++;
        }
      } catch (error) {
        results.push({ success: false, event, error: (error as Error).message });
        if (this.enableMetrics) {
          if (!this.metrics.streams[streamKeyName]) {
            this.metrics.streams[streamKeyName] = { published: 0, consumed: 0, errors: 0 };
          }
          this.metrics.streams[streamKeyName].errors++;
        }
      }
    }
    
    return results;
  }

  /**
   * Get health status
   * @returns {Promise<{status: string, connections: {main: boolean, pubsub: boolean}, timestamp: string, error?: string}>} Health status object
   */
  async getHealth(): Promise<{status: string, connections: {main: boolean, pubsub: boolean}, timestamp: string, error?: string}> {
    const health = {
      status: 'healthy',
      connections: {
        main: this.client.isOpen,
        pubsub: this.pubsub.isOpen
      },
      timestamp: new Date().toISOString()
    };

    if (!health.connections.main || !health.connections.pubsub) {
      health.status = 'unhealthy';
    }

    try {
      await this.ping();
    } catch (error) {
      health.status = 'unhealthy';
      (health as any).error = (error as Error).message;
    }

    return health;
  }

  /**
   * Get performance metrics
   * @returns {{operations: {total: number, successful: number, failed: number}, latency: {avg: number, p50: number, p95: number, p99: number}, connections: {active: number, idle: number, total: number}, streams: Object.<string, {published: number, consumed: number, errors: number}>}} Metrics object
   */
  getMetrics(): {operations: {total: number, successful: number, failed: number}, latency: {avg: number, p50: number, p95: number, p99: number}, connections: {active: number, idle: number, total: number}, streams: Record<string, {published: number, consumed: number, errors: number}>} {
    const latencyValues = this.metrics.latency.values;
    const sorted = [...latencyValues].sort((a, b) => a - b);
    
    return {
      operations: { ...this.metrics.operations },
      latency: {
        avg: latencyValues.length ? 
          latencyValues.reduce((a, b) => a + b, 0) / latencyValues.length : 0,
        p50: sorted[Math.floor(sorted.length * 0.5)] || 0,
        p95: sorted[Math.floor(sorted.length * 0.95)] || 0,
        p99: sorted[Math.floor(sorted.length * 0.99)] || 0
      },
      connections: {
        active: this.client.isOpen ? 1 : 0,
        idle: 0,
        total: 1
      },
      streams: { ...this.metrics.streams }
    };
  }

  /**
   * Get stream health status
   * @param {string} streamKeyName - Stream key name
   * @returns {Promise<{exists: boolean, length: number, groups: number, consumers: number, pending: number}>} Stream health object
   */
  async getStreamHealth(streamKeyName: string): Promise<{exists: boolean, length: number, groups: number, consumers: number, pending: number}> {
    if (!this.client.isOpen) await this.client.connect();
    
    try {
      const exists = await this.client.exists(streamKeyName);
      if (!exists) {
        return {
          exists: false,
          length: 0,
          groups: 0,
          consumers: 0,
          pending: 0
        };
      }

      const length = await this.client.xLen(streamKeyName);
      const groups = await this.client.xInfoGroups(streamKeyName).catch(() => []);
      
      let totalConsumers = 0;
      let totalPending = 0;
      
      for (const group of groups) {
        totalConsumers += (group as any).consumers;
        totalPending += (group as any).pending;
      }

      return {
        exists: true,
        length,
        groups: groups.length,
        consumers: totalConsumers,
        pending: totalPending
      };
    } catch (error) {
      this.logger.error('Error getting stream health:', error);
      throw error;
    }
  }

  /**
   * Get stream metrics
   * @param {string} streamKeyName - Stream key name
   * @returns {{published: number, consumed: number, errors: number, avgProcessingTime: number}} Stream metrics object
   */
  getStreamMetrics(streamKeyName: string): {published: number, consumed: number, errors: number, avgProcessingTime: number} {
    const metrics = this.streamMetrics.get(streamKeyName) || {
      published: 0,
      consumed: 0,
      errors: 0,
      processingTimes: []
    };

    const avgProcessingTime = metrics.processingTimes.length ?
      metrics.processingTimes.reduce((a: number, b: number) => a + b, 0) / metrics.processingTimes.length : 0;

    return {
      published: metrics.published,
      consumed: metrics.consumed,
      errors: metrics.errors,
      avgProcessingTime
    };
  }

  /**
   * Add member(s) to a sorted set
   * @param {string} key - Sorted set key
   * @param {Array<{score: number, value: string}>|{score: number, value: string}} members - Member(s) to add
   * @returns {Promise<number>} Number of elements added
   */
  async zadd(key: string, members: Array<{score: number, value: string}> | {score: number, value: string}): Promise<number> {
    if (!this.client.isOpen) await this.client.connect();
    const membersArray = Array.isArray(members) ? members : [members];
    return this.executeWithMiddleware('zadd', [key, membersArray], () => 
      this.trackMetrics('zadd', () => this.client.zAdd(key, membersArray))
    );
  }

  /**
   * Get range of members from sorted set
   * @param {string} key - Sorted set key
   * @param {number} start - Start index
   * @param {number} stop - Stop index
   * @param {boolean} [withScores=false] - Include scores in result
   * @returns {Promise<string[]|Array<{value: string, score: number}>>} Array of members or members with scores
   */
  async zrange(key: string, start: number, stop: number, withScores: boolean = false): Promise<string[] | Array<{value: string, score: number}>> {
    if (!this.client.isOpen) await this.client.connect();
    return this.executeWithMiddleware('zrange', [key, start, stop, withScores], () => 
      this.trackMetrics('zrange', () => 
        withScores ? this.client.zRangeWithScores(key, start, stop) : this.client.zRange(key, start, stop)
      )
    );
  }

  /**
   * Push element(s) to the left of a list
   * @param {string} key - List key
   * @param {string|string[]} element - Element(s) to push
   * @returns {Promise<number>} Length of list after push
   */
  async lpush(key: string, element: string | string[]): Promise<number> {
    if (!this.client.isOpen) await this.client.connect();
    const elements = Array.isArray(element) ? element : [element];
    return this.executeWithMiddleware('lpush', [key, elements], () => 
      this.trackMetrics('lpush', () => this.client.lPush(key, elements))
    );
  }

  /**
   * Push element(s) to the right of a list
   * @param {string} key - List key
   * @param {string|string[]} element - Element(s) to push
   * @returns {Promise<number>} Length of list after push
   */
  async rpush(key: string, element: string | string[]): Promise<number> {
    if (!this.client.isOpen) await this.client.connect();
    const elements = Array.isArray(element) ? element : [element];
    return this.executeWithMiddleware('rpush', [key, elements], () => 
      this.trackMetrics('rpush', () => this.client.rPush(key, elements))
    );
  }

  /**
   * Pop element from the left of a list
   * @param {string} key - List key
   * @returns {Promise<string|null>} Popped element or null if list is empty
   */
  async lpop(key: string): Promise<string | null> {
    if (!this.client.isOpen) await this.client.connect();
    return this.executeWithMiddleware('lpop', [key], () => 
      this.trackMetrics('lpop', () => this.client.lPop(key))
    );
  }

  /**
   * Pop element from the right of a list
   * @param {string} key - List key
   * @returns {Promise<string|null>} Popped element or null if list is empty
   */
  async rpop(key: string): Promise<string | null> {
    if (!this.client.isOpen) await this.client.connect();
    return this.executeWithMiddleware('rpop', [key], () => 
      this.trackMetrics('rpop', () => this.client.rPop(key))
    );
  }

  /**
   * Get the length of a list
   * @param {string} key - List key
   * @returns {Promise<number>} Length of the list
   */
  async llen(key: string): Promise<number> {
    if (!this.client.isOpen) await this.client.connect();
    return this.executeWithMiddleware('llen', [key], () => 
      this.trackMetrics('llen', () => this.client.lLen(key))
    );
  }

  /**
   * Get range of elements from a list
   * @param {string} key - List key
   * @param {number} start - Start index
   * @param {number} stop - Stop index
   * @returns {Promise<string[]>} Array of elements
   */
  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    if (!this.client.isOpen) await this.client.connect();
    return this.executeWithMiddleware('lrange', [key, start, stop], () => 
      this.trackMetrics('lrange', () => this.client.lRange(key, start, stop))
    );
  }

  /**
   * Check if member exists in a set
   * @param {string} key - Set key
   * @param {string} member - Member to check
   * @returns {Promise<boolean>} True if member exists
   */
  async sismember(key: string, member: string): Promise<boolean> {
    if (!this.client.isOpen) await this.client.connect();
    return this.executeWithMiddleware('sismember', [key, member], () => 
      this.trackMetrics('sismember', () => this.client.sIsMember(key, member))
    );
  }

  /**
   * Get the number of members in a set
   * @param {string} key - Set key
   * @returns {Promise<number>} Number of members
   */
  async scard(key: string): Promise<number> {
    if (!this.client.isOpen) await this.client.connect();
    return this.executeWithMiddleware('scard', [key], () => 
      this.trackMetrics('scard', () => this.client.sCard(key))
    );
  }

  /**
   * Remove specified member from sorted set
   * @param {string} key - Sorted set key
   * @param {string|string[]} member - Member(s) to remove
   * @returns {Promise<number>} Number of members removed
   */
  async zrem(key: string, member: string | string[]): Promise<number> {
    if (!this.client.isOpen) await this.client.connect();
    const members = Array.isArray(member) ? member : [member];
    return this.executeWithMiddleware('zrem', [key, members], () => 
      this.trackMetrics('zrem', () => this.client.zRem(key, members))
    );
  }

  /**
   * Get the score of a member in a sorted set
   * @param {string} key - Sorted set key
   * @param {string} member - Member to get score for
   * @returns {Promise<number|null>} Score or null if member doesn't exist
   */
  async zscore(key: string, member: string): Promise<number | null> {
    if (!this.client.isOpen) await this.client.connect();
    return this.executeWithMiddleware('zscore', [key, member], () => 
      this.trackMetrics('zscore', () => this.client.zScore(key, member))
    );
  }

  /**
   * Get the number of members in a sorted set
   * @param {string} key - Sorted set key
   * @returns {Promise<number>} Number of members
   */
  async zcard(key: string): Promise<number> {
    if (!this.client.isOpen) await this.client.connect();
    return this.executeWithMiddleware('zcard', [key], () => 
      this.trackMetrics('zcard', () => this.client.zCard(key))
    );
  }
}
