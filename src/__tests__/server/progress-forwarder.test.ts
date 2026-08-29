import { describe, it, expect } from '@jest/globals';
import { progressForwarder, type ProgressCapableExtra } from '../../server/tools/progress.js';

function fakeExtra(sent: Array<{ method: string; params: Record<string, unknown> }>): ProgressCapableExtra {
  return {
    _meta: { progressToken: 42 },
    sendNotification: async (n: { method: string; params: Record<string, unknown> }) => {
      sent.push(n);
    },
  } as unknown as ProgressCapableExtra;
}

describe('progressForwarder', () => {
  it('sends nothing without a progressToken', () => {
    expect(progressForwarder(undefined)).toBeNull();
    expect(progressForwarder({ _meta: {}, sendNotification: async () => undefined } as unknown as ProgressCapableExtra)).toBeNull();
  });

  it('forwards progress values under the client token', async () => {
    const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
    const f = progressForwarder(fakeExtra(sent));
    f!.onProgress({ bytes: 10, elapsedMs: 1, message: 'streaming' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method: 'notifications/progress', params: { progressToken: 42, progress: 10, message: 'streaming' } });
  });

  it('clamps non-monotonic input so the client never sees progress move backwards', async () => {
    const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
    const f = progressForwarder(fakeExtra(sent));
    f!.onProgress({ bytes: 100, elapsedMs: 1 });
    f!.onProgress({ bytes: 40, elapsedMs: 2 }); // recomputed base after a fallback
    f!.onProgress({ bytes: 120, elapsedMs: 3 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(sent.map((s) => (s.params as { progress: number }).progress)).toEqual([100, 100, 120]);
  });
});
