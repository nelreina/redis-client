/** Public types shared by the stream helpers. */
import type {
  AutoClaimOptions,
  DrainOptions,
  EventHandler,
} from "@nelreina/redis-stream-event";

/** Options of `RedisClient.startEventStream()` */
export interface StartEventStreamOptions {
  /** Async handler per message (`message.ack()` acknowledges) */
  handler: EventHandler;
  /** Event filter; null/undefined/true/false = all events; a string = one event */
  events?: string[] | string | boolean | null;
  /** Group creation id when the group does not exist (MKSTREAM). Default "$" */
  startId?: string;
  /** Consumer name for this loop (default: the client's `streamConsumerName`) */
  consumerName?: string;
  /** Consumer group (default: the client's `serviceName`) */
  group?: string;
  /** XREADGROUP BLOCK in ms (default 30000 from redis-stream-event; 5000 recommended for tenant loops) */
  blockMs?: number;
  /** PEL drain options of redis-stream-event 0.11 (`false` disables) */
  drain?: DrainOptions | false;
  /** XAUTOCLAIM options of redis-stream-event 0.11 (`false` disables) */
  autoClaim?: AutoClaimOptions | false;
}

/** Handle of one consumer loop */
export interface EventStreamHandle {
  readonly streamKey: string;
  readonly consumerName: string;
  /** CLIENT ID of the loop's blocking connection (0 until the loop has started) */
  readonly clientId: number;
  /** True while the loop runs */
  readonly running: boolean;
  /** Stops the loop: unblocks the read, waits for the in-flight handler (it may ack), closes the connection */
  stop(): Promise<void>;
  /** Resolves when the loop was stopped; rejects when it failed (handler throw, Redis error, group creation failure) */
  done: Promise<void>;
}
