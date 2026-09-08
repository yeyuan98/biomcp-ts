import { describe, expect, it, afterEach } from '@jest/globals';
import { SessionManager } from '../../remote/session.js';

describe('SessionManager', () => {
  let manager: SessionManager;

  afterEach(async () => {
    if (manager) {
      await manager.closeAll();
    }
  });

  it('creates sessions with unique IDs', async () => {
    manager = new SessionManager(60_000, 10);
    const s1 = await manager.createSession({ clientLabel: 'client-1' });
    const s2 = await manager.createSession({ clientLabel: 'client-2' });

    expect(s1.sessionId).toBeDefined();
    expect(s2.sessionId).toBeDefined();
    expect(s1.sessionId).not.toBe(s2.sessionId);
    expect(manager.count).toBe(2);

    expect(manager.getSession(s1.sessionId)?.clientLabel).toBe('client-1');
  });

  it('updates lastActiveAt when getSession is called', async () => {
    manager = new SessionManager(60_000, 10);
    const session = await manager.createSession();
    const createdTime = session.lastActiveAt;

    await new Promise((r) => setTimeout(r, 10));
    const retrieved = manager.getSession(session.sessionId);

    expect(retrieved?.lastActiveAt).toBeGreaterThanOrEqual(createdTime);
  });

  it('closes individual sessions', async () => {
    manager = new SessionManager(60_000, 10);
    const s1 = await manager.createSession();
    expect(manager.count).toBe(1);

    await manager.closeSession(s1.sessionId);
    expect(manager.count).toBe(0);
    expect(manager.getSession(s1.sessionId)).toBeUndefined();
  });

  it('evicts oldest session when maxSessions limit is reached', async () => {
    manager = new SessionManager(60_000, 2);
    const s1 = await manager.createSession({ clientLabel: 's1' });
    await new Promise((r) => setTimeout(r, 10));
    const s2 = await manager.createSession({ clientLabel: 's2' });
    await new Promise((r) => setTimeout(r, 10));
    const s3 = await manager.createSession({ clientLabel: 's3' });

    expect(manager.count).toBe(2);
    // s1 should have been evicted
    expect(manager.getSession(s1.sessionId)).toBeUndefined();
    expect(manager.getSession(s2.sessionId)).toBeDefined();
    expect(manager.getSession(s3.sessionId)).toBeDefined();
  });
});
