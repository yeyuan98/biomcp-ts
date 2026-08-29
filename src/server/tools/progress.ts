import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';

/**
 * Structural slice of the SDK request-handler `extra` that progress wiring
 * needs — any tool module's handler extra satisfies it, so the forwarder is
 * reusable beyond biowasm (e.g. ranalysis) without importing its full type.
 */
export type ProgressCapableExtra = Pick<RequestHandlerExtra<ServerRequest, ServerNotification>, '_meta' | 'sendNotification'>;

export interface ProgressForwarder {
  onProgress: (progress: { bytes: number; elapsedMs: number; message?: string }) => void;
}

/**
 * Forward a module's progress sink to the client's `notifications/progress`
 * when (and only when) the request carried `_meta.progressToken` (SDK 1.30
 * surfaces it at `extra._meta.progressToken`). Returns null when no token is
 * present — tokenless clients get silence. Never throws: progress is
 * best-effort and must not break the tool call it reports on.
 */
export function progressForwarder(extra: ProgressCapableExtra | undefined): ProgressForwarder | null {
  const progressToken = extra?._meta?.progressToken;
  if (extra === undefined || progressToken === undefined || progressToken === null) return null;
  const sender = extra;
  return {
    onProgress: (p) => {
      try {
        void sender
          .sendNotification({
            method: 'notifications/progress',
            params: {
              progressToken,
              progress: p.bytes,
              ...(p.message ? { message: p.message } : {}),
            },
          })
          .catch(() => undefined);
      } catch {
        // Sending failed synchronously (transport closing, etc.) — swallow.
      }
    },
  };
}
