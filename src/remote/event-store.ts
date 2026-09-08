import type { EventStore, StreamId, EventId } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

interface StoredEvent {
  id: EventId;
  message: JSONRPCMessage;
  timestamp: number;
}

export interface BoundedEventStoreOptions {
  /** Maximum number of events to retain per stream (default: 100). */
  maxEventsPerStream?: number;
  /** Maximum number of concurrent streams to track (default: 1000). */
  maxStreams?: number;
  /** Time-to-live in ms for stored events (default: 15 minutes). */
  ttlMs?: number;
}

/**
 * Bounded in-memory event store supporting Streamable HTTP resumability.
 * Enforces per-stream sliding capacity and expiration to prevent unbounded memory growth.
 */
export class BoundedInMemoryEventStore implements EventStore {
  private readonly maxEvents: number;
  private readonly maxStreams: number;
  private readonly ttlMs: number;
  private readonly streams = new Map<StreamId, StoredEvent[]>();
  private readonly eventToStream = new Map<EventId, StreamId>();
  private counter = 0;

  constructor(options?: BoundedEventStoreOptions) {
    this.maxEvents = options?.maxEventsPerStream ?? 100;
    this.maxStreams = options?.maxStreams ?? 1000;
    this.ttlMs = options?.ttlMs ?? 15 * 60 * 1000;
  }

  async storeEvent(streamId: StreamId, message: JSONRPCMessage): Promise<EventId> {
    const now = Date.now();
    this.counter = (this.counter + 1) % 1_000_000;
    const eventId = `${Date.now()}_${this.counter}`;

    let list = this.streams.get(streamId);
    if (!list) {
      if (this.streams.size >= this.maxStreams) {
        const oldestKey = this.streams.keys().next().value;
        if (oldestKey) this.deleteStream(oldestKey);
      }
      list = [];
      this.streams.set(streamId, list);
    }

    // Prune expired events in this stream
    const cutoff = now - this.ttlMs;
    while (list.length > 0 && list[0].timestamp < cutoff) {
      const expired = list.shift()!;
      this.eventToStream.delete(expired.id);
    }

    // Enforce max capacity
    while (list.length >= this.maxEvents) {
      const dropped = list.shift()!;
      this.eventToStream.delete(dropped.id);
    }

    list.push({ id: eventId, message, timestamp: now });
    this.eventToStream.set(eventId, streamId);
    return eventId;
  }

  async getStreamIdForEventId(eventId: EventId): Promise<StreamId | undefined> {
    return this.eventToStream.get(eventId);
  }

  async replayEventsAfter(
    lastEventId: EventId,
    { send }: { send: (eventId: EventId, message: JSONRPCMessage) => Promise<void> },
  ): Promise<StreamId> {
    const streamId = this.eventToStream.get(lastEventId);
    if (!streamId) {
      throw new Error(`Event ID ${lastEventId} not found in event store.`);
    }

    const list = this.streams.get(streamId);
    if (!list) return streamId;

    const targetIdx = list.findIndex((e) => e.id === lastEventId);
    const eventsToReplay = targetIdx >= 0 ? list.slice(targetIdx + 1) : list;

    for (const item of eventsToReplay) {
      await send(item.id, item.message);
    }

    return streamId;
  }

  /** Removes all events associated with a terminated stream. */
  deleteStream(streamId: StreamId): void {
    const list = this.streams.get(streamId);
    if (list) {
      for (const item of list) {
        this.eventToStream.delete(item.id);
      }
      this.streams.delete(streamId);
    }
  }

  /** Clears all stored events across all streams. */
  clear(): void {
    this.streams.clear();
    this.eventToStream.clear();
  }
}
