import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createBioMcpServer } from '../server/factory.js';
import type { EventStore } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { RemoteSession } from './types.js';

export interface CreateSessionOptions {
  clientLabel?: string;
  enableJsonResponse?: boolean;
  eventStore?: EventStore;
  readOnlyConfig?: boolean;
}

export class SessionManager {
  private readonly sessions = new Map<string, RemoteSession>();
  private sweeperTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly defaultIdleTimeoutMs: number = 30 * 60 * 1000,
    private readonly maxSessions: number = 500,
  ) {}

  get count(): number {
    return this.sessions.size;
  }

  async createSession(options?: CreateSessionOptions): Promise<RemoteSession> {
    // If at or exceeding max sessions, evict oldest
    if (this.sessions.size >= this.maxSessions) {
      this.evictOldest();
    }

    const sessionId = randomUUID();
    const server = createBioMcpServer({ readOnlyConfig: options?.readOnlyConfig ?? true });

    let resolveInit: (() => void) | null = null;
    const initPromise = new Promise<void>((resolve) => {
      resolveInit = resolve;
    });

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => sessionId,
      enableJsonResponse: options?.enableJsonResponse ?? false,
      eventStore: options?.eventStore,
      keepAliveMs: 15_000,
      onsessioninitialized: async (_sid: string) => {
        resolveInit?.();
      },
      onsessionclosed: async (sid: string) => {
        this.sessions.delete(sid);
      },
    });

    await server.connect(transport);

    const now = Date.now();
    const session: RemoteSession = {
      sessionId,
      server,
      transport,
      clientLabel: options?.clientLabel ?? 'default',
      createdAt: now,
      lastActiveAt: now,
    };

    this.sessions.set(sessionId, session);
    return session;
  }

  getSession(sessionId: string): RemoteSession | undefined {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActiveAt = Date.now();
    }
    return session;
  }

  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      this.sessions.delete(sessionId);
      try {
        await session.transport.close();
      } catch {
        // Ignore close error
      }
      try {
        await session.server.close();
      } catch {
        // Ignore close error
      }
    }
  }

  async closeAll(): Promise<void> {
    this.stopIdleSweeper();
    const sessionList = Array.from(this.sessions.values());
    this.sessions.clear();
    await Promise.allSettled(
      sessionList.map(async (s) => {
        try {
          await s.transport.close();
        } catch {
          // Ignore
        }
        try {
          await s.server.close();
        } catch {
          // Ignore
        }
      }),
    );
  }

  startIdleSweeper(intervalMs: number = 60_000, idleTimeoutMs?: number): void {
    if (this.sweeperTimer) return;
    const timeout = idleTimeoutMs ?? this.defaultIdleTimeoutMs;

    this.sweeperTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, session] of this.sessions.entries()) {
        if (now - session.lastActiveAt > timeout) {
          void this.closeSession(id);
        }
      }
      while (this.sessions.size > this.maxSessions) {
        this.evictOldest();
      }
    }, intervalMs);

    this.sweeperTimer.unref();
  }

  stopIdleSweeper(): void {
    if (this.sweeperTimer) {
      clearInterval(this.sweeperTimer);
      this.sweeperTimer = null;
    }
  }

  private evictOldest(): void {
    let oldestId: string | null = null;
    let oldestTime = Infinity;

    for (const [id, session] of this.sessions.entries()) {
      if (session.lastActiveAt < oldestTime) {
        oldestTime = session.lastActiveAt;
        oldestId = id;
      }
    }

    if (oldestId) {
      void this.closeSession(oldestId);
    }
  }
}
