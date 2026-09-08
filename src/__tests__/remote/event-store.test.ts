import { describe, expect, it } from '@jest/globals';
import { BoundedInMemoryEventStore } from '../../remote/event-store.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

describe('BoundedInMemoryEventStore', () => {
  it('stores and looks up events by stream', async () => {
    const store = new BoundedInMemoryEventStore({ maxEventsPerStream: 5 });
    const msg: JSONRPCMessage = { jsonrpc: '2.0', method: 'ping' };

    const eventId = await store.storeEvent('stream-1', msg);
    expect(eventId).toBeDefined();

    const streamId = await store.getStreamIdForEventId(eventId);
    expect(streamId).toBe('stream-1');
  });

  it('drops oldest events when capacity is reached', async () => {
    const store = new BoundedInMemoryEventStore({ maxEventsPerStream: 3 });
    const e1 = await store.storeEvent('stream-1', { jsonrpc: '2.0', id: 1, method: 'a' });
    const e2 = await store.storeEvent('stream-1', { jsonrpc: '2.0', id: 2, method: 'b' });
    const e3 = await store.storeEvent('stream-1', { jsonrpc: '2.0', id: 3, method: 'c' });
    const e4 = await store.storeEvent('stream-1', { jsonrpc: '2.0', id: 4, method: 'd' });

    // e1 should have been dropped
    expect(await store.getStreamIdForEventId(e1)).toBeUndefined();
    expect(await store.getStreamIdForEventId(e2)).toBe('stream-1');
    expect(await store.getStreamIdForEventId(e3)).toBe('stream-1');
    expect(await store.getStreamIdForEventId(e4)).toBe('stream-1');
  });

  it('replays events after lastEventId', async () => {
    const store = new BoundedInMemoryEventStore({ maxEventsPerStream: 5 });
    const e1 = await store.storeEvent('s1', { jsonrpc: '2.0', id: 1, method: 'm1' });
    const e2 = await store.storeEvent('s1', { jsonrpc: '2.0', id: 2, method: 'm2' });
    const e3 = await store.storeEvent('s1', { jsonrpc: '2.0', id: 3, method: 'm3' });

    const replayed: Array<{ id: string; msg: JSONRPCMessage }> = [];
    const stream = await store.replayEventsAfter(e1, {
      send: async (id, msg) => {
        replayed.push({ id, msg });
      },
    });

    expect(stream).toBe('s1');
    expect(replayed.length).toBe(2);
    expect(replayed[0].id).toBe(e2);
    expect(replayed[1].id).toBe(e3);
  });

  it('deletes stream', async () => {
    const store = new BoundedInMemoryEventStore();
    const e1 = await store.storeEvent('s1', { jsonrpc: '2.0', method: 'm1' });
    store.deleteStream('s1');
    expect(await store.getStreamIdForEventId(e1)).toBeUndefined();
  });
});
