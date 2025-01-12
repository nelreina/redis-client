import { createClient } from "redis";
import RedisStreamEvent from "@nelreina/redis-stream-event";

/**
 * Redis client wrapper class that provides simplified Redis operations
 * including Pub/Sub, Streams, Hash operations, and more.
 */
export class RedisClient {
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
   */
  constructor({
    redisHost,
    redisPort = 6379,
    redisUser,
    redisPw,
    serviceName = "NO-NAME",
    timeZone = "America/Curacao",
    streamMaxLength = 10000,
  }) {
    this.url = this.buildRedisUrl(redisHost, redisPort, redisUser, redisPw);
    this.serviceName = serviceName;
    this.client = createClient({ url: this.url, name: this.serviceName });
    this.pubsub = this.client.duplicate();
    this.eventStream = null;
    this.timeZone = timeZone;
    this.streamMaxLength = streamMaxLength;
    this.client.on("connect", () => {
      console.info(`✅ Connected to redis: ${this.url}`);
    });

    this.client.on("error", (error) => {
      console.error(`❌ Error connecting to redis: ${this.url}`);
      console.error(error);
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
  buildRedisUrl(host, port, user, password) {
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
   * @param {Function} callback - Callback function to handle received messages
   * @returns {Promise<void>}
   */
  async subscribe2RedisChannel(channel, callback) {
    if (!this.pubsub.isOpen) await this.pubsub.connect();
    await this.pubsub.subscribe(channel, (payload) => {
      try {
        callback(JSON.parse(payload));
      } catch (error) {
        callback(payload);
        console.error(error.message);
      }
    });
    console.info(`✅ Subscribed to redis channel: ${channel}`);
  }

  /**
   * Publishes a message to a Redis channel
   * @param {string} channel - Channel name to publish to
   * @param {Object|string} payload - Message payload to publish
   * @returns {Promise<number>} Number of clients that received the message
   */
  async publish2RedisChannel(channel, payload) {
    if (!this.pubsub.isOpen) await this.pubsub.connect();
    let message;
    try {
      message = JSON.stringify(payload);
    } catch (error) {
      message = payload;
      console.error(error.message);
    }
    return await this.pubsub.publish(channel, message);
  }

  /**
   * Sets multiple hash fields to multiple values
   * @param {string} key - Hash key
   * @param {Object} object - Object containing field-value pairs
   * @returns {Promise<number>} Number of fields that were added
   */
  async setHashValue(key, object) {
    if (!this.client.isOpen) await this.client.connect();
    const values = Object.entries(object).reduce((acc, [key, value]) => {
      acc.push(key);
      acc.push(value);
      return acc;
    }, []);
    return await this.client.hSet(key, values);
  }

  /**
   * Retrieves all hash values from a set
   * @param {string} key - Set key containing hash keys
   * @returns {Promise<Array>} Array of hash objects with their values
   */
  async getAllSetHashValues(key) {
    if (!this.client.isOpen) await this.client.connect();
    const keys = await this.client.sMembers(key);
    const values = [];
    for (const key of keys) {
      const data = { event: key, ...(await this.client.hGetAll(key)) };
      values.push(data);
    }
    return values;
  }

  /**
   * Sets a string value and adds it to a set
   * @param {string} setKey - Set key to add the string key to
   * @param {string} key - String key
   * @param {string} value - String value
   * @returns {Promise<boolean>} Operation success status
   */
  async setStringValue(setKey, key, value) {
    if (!this.client.isOpen) await this.client.connect();
    await this.client.set(key, value);
    await this.client.sAdd(setKey, key);
    return true;
  }

  /**
   * Retrieves all string values from keys in a set
   * @param {string} setKey - Set key containing string keys
   * @returns {Promise<Array<string>>} Array of string values
   */
  async getAllStringValues(setKey) {
    if (!this.client.isOpen) await this.client.connect();
    const keys = await this.client.sMembers(setKey);
    const values = [];
    for (const key of keys) {
      values.push(await this.client.get(key));
    }
    return values;
  }

  /**
   * Clears all string values referenced by keys in a set
   * @param {string} setKey - Set key containing string keys
   * @returns {Promise<boolean>} Operation success status
   */
  async clearStringValues(setKey) {
    if (!this.client.isOpen) await this.client.connect();
    const keys = await this.client.sMembers(setKey);
    for (const key of keys) {
      await this.client.del(key);
    }
    return true;
  }

  /**
   * Gets or creates a Redis Stream Event instance
   * @param {string} streamKeyName - Stream key name
   * @returns {RedisStreamEvent} Redis Stream Event instance
   */
  getEventStream(streamKeyName, streamOptions = {}) {
    if (!this.eventStream) {
      return new RedisStreamEvent(
        this.client,
        streamKeyName,
        this.serviceName,
        streamOptions,
      );
    }
    return this.eventStream;
  }

  /**
   * Connects to a Redis Stream and sets up event handling
   * @param {string} streamKeyName - Stream key name
   * @param {Function} [handler=(str) => console.info(str)] - Event handler function
   * @param {boolean|Array<string>} [events=false] - Events to filter (true for all events)
   * @returns {Promise<void>}
   */
  async connectToEventStream(
    streamKeyName,
    handler = (str) => console.info(str),
    events = false,
  ) {
    this.eventStream = this.getEventStream(streamKeyName, {
      timeZone: this.timeZone,
      maxLength: this.streamMaxLength,
    });

    if (!this.client.isOpen) await this.client.connect();
    const stream = await this.eventStream.createStream(
      streamKeyName,
      this.serviceName,
    );
    await stream.subscribe(handler, events);
  }

  /**
   * Publishes an event to a Redis Stream
   * @param {string} streamKeyName - Stream key name
   * @param {string} event - Event type
   * @param {string} aggregateId - Aggregate identifier
   * @param {Object} payload - Event payload
   * @returns {Promise<void>}
   */
  async publishToStream(streamKeyName, event, aggregateId, payload) {
    if (!this.client.isOpen) await this.client.connect();
    const eventStream = this.getEventStream(streamKeyName);
    await eventStream.publish(event, aggregateId, payload);
  }

  /**
   * Gets a value by key from Redis
   * @param {string} key - Key to retrieve
   * @returns {Promise<string|null>} Value associated with the key
   */
  async get(key) {
    if (!this.client.isOpen) await this.client.connect();
    return await this.client.get(key);
  }

  /**
   * Sets a value by key from Redis
   * @param {string} key - Key to retrieve
   * @param {string} value - Value to set
   * @returns {Promise<string|null>} Value associated with the key
   */
  async set(key, value) {
    if (!this.client.isOpen) await this.client.connect();
    return await this.client.set(key, value);
  }

  /**
   * Closes the Redis client connection
   * @returns {Promise<void>}
   */
  async close() {
    if (!this.client.isOpen) return;
    await this.client.close();
    console.info("✅ Redis client connection closed");

    if (!this.pubsub.isOpen) return;
    await this.pubsub.close();
    console.info("✅ Redis pubsub connection closed");
  }

  /**
   * Increments a value by a specified amount
   * @param {string} key - Key to increment
   * @param {number} value - Amount to increment by
   * @returns {Promise<number>} New value after increment
   */
  async incrBy(key, value) {
    if (!this.client.isOpen) await this.client.connect();
    return await this.client.incrBy(key, value);
  }

  /**
   * Gets the Redis client connection
   * To execute Redis commands directly
   * @returns {RedisClient} Redis client connection
   */
  getConnection() {
    return this.client;
  }
}
