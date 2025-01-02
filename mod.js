import { createClient } from "redis";
import RedisStreamEvent from "@nelreina/redis-stream-event";

export class RedisClient {
  constructor({
    redisHost,
    redisPort = 6379,
    redisUser,
    redisPw,
    serviceName = "NO-NAME",
  }) {
    this.url = this.buildRedisUrl(redisHost, redisPort, redisUser, redisPw);
    this.serviceName = serviceName;
    this.client = createClient({ url: this.url, name: this.serviceName });
    this.pubsub = this.client.duplicate();
    this.eventStream = null;

    this.client.on("connect", () => {
      console.info(`✅ Connected to redis: ${this.url}`);
    });

    this.client.on("error", (error) => {
      console.error(`❌ Error connecting to redis: ${this.url}`);
      console.error(error);
    });
    if (!this.client.isOpen) this.client.connect();
  }

  buildRedisUrl(host, port, user, password) {
    if (!host) return undefined;

    let url = "redis://";
    if (user && password) {
      url += `${user}:${password}@`;
    }
    url += `${host}:${port}`;
    return url;
  }

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

  async setHashValue(key, object) {
    if (!this.client.isOpen) await this.client.connect();
    const values = Object.entries(object).reduce((acc, [key, value]) => {
      acc.push(key);
      acc.push(value);
      return acc;
    }, []);
    return await this.client.hSet(key, values);
  }

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

  async setStringValue(setKey, key, value) {
    if (!this.client.isOpen) await this.client.connect();
    await this.client.set(key, value);
    await this.client.sAdd(setKey, key);
    return true;
  }

  async getAllStringValues(setKey) {
    if (!this.client.isOpen) await this.client.connect();
    const keys = await this.client.sMembers(setKey);
    const values = [];
    for (const key of keys) {
      values.push(await this.client.get(key));
    }
    return values;
  }

  async clearStringValues(setKey) {
    if (!this.client.isOpen) await this.client.connect();
    const keys = await this.client.sMembers(setKey);
    for (const key of keys) {
      await this.client.del(key);
    }
    return true;
  }

  getEventStream(streamKeyName) {
    if (!this.eventStream) {
      return new RedisStreamEvent(this.client, streamKeyName, this.serviceName);
    }
    return this.eventStream;
  }

  async connectToEventStream(
    streamKeyName,
    handler = (str) => console.info(str),
    events = false,
  ) {
    this.eventStream = this.getEventStream(streamKeyName);

    if (!this.client.isOpen) await this.client.connect();
    const stream = await this.eventStream.createStream(
      streamKeyName,
      this.serviceName,
    );
    await stream.subscribe(handler, events);
  }

  async publishToStream(streamKeyName, event, aggregateId, payload) {
    if (!this.client.isOpen) await this.client.connect();
    const eventStream = this.getEventStream(streamKeyName);
    await eventStream.publish(event, aggregateId, payload);
  }

  async get(key) {
    if (!this.client.isOpen) await this.client.connect();
    return await this.client.get(key);
  }
}
