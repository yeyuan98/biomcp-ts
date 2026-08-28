import { describe, it, expect } from '@jest/globals';
import { SerializationQueue } from '../../wasmcore/queue.js';

describe('SerializationQueue', () => {
  it('runs jobs sequentially in submission order', async () => {
    const queue = new SerializationQueue();
    const order: string[] = [];
    const job = (id: string, ms: number) => async () => {
      order.push(`start:${id}`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`end:${id}`);
      return id;
    };
    const results = await Promise.all([queue.enqueue(job('a', 30)), queue.enqueue(job('b', 5))]);
    expect(results).toEqual(['a', 'b']);
    expect(order).toEqual(['start:a', 'end:a', 'start:b', 'end:b']);
  });

  it('keeps the chain working after a rejected job', async () => {
    const queue = new SerializationQueue();
    await expect(queue.enqueue(async () => { throw new Error('boom'); })).rejects.toThrow(/boom/);
    await expect(queue.enqueue(async () => 'ok')).resolves.toBe('ok');
  });

  it('still runs the next job when a concurrent predecessor rejects', async () => {
    const queue = new SerializationQueue();
    let ran = false;
    const failing = queue.enqueue(async () => {
      await new Promise((r) => setTimeout(r, 10));
      throw new Error('x');
    });
    const following = queue.enqueue(async () => {
      ran = true;
      return 1;
    });
    await expect(failing).rejects.toThrow(/x/);
    await expect(following).resolves.toBe(1);
    expect(ran).toBe(true);
  });

  it('reset decouples later jobs from earlier still-running ones', async () => {
    const queue = new SerializationQueue();
    let slowDone = false;
    const slow = queue.enqueue(async () => {
      await new Promise((r) => setTimeout(r, 50));
      slowDone = true;
    });
    queue.reset();
    await expect(queue.enqueue(async () => 'fast')).resolves.toBe('fast');
    expect(slowDone).toBe(false);
    await slow;
    expect(slowDone).toBe(true);
  });
});
