import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerGeneTools } from '../../server/tools/gene.js';
import { registerVariantTools } from '../../server/tools/variant.js';
import { registerDrugTools } from '../../server/tools/drug.js';
import { registerDiseaseTools } from '../../server/tools/disease.js';
import { registerArticleTools } from '../../server/tools/article.js';
import { registerTrialTools } from '../../server/tools/trial.js';
import { registerUtilityTools } from '../../server/tools/utility.js';
import { registerPdbTools } from '../../server/tools/pdb.js';
import { registerPatentTools } from '../../server/tools/patent.js';
import { registerGeoTools } from '../../server/tools/geo.js';
import { registerSraTools } from '../../server/tools/sra.js';
import { registerGenbankTools } from '../../server/tools/genbank.js';
import { registerGtexTools } from '../../server/tools/gtex.js';
import { registerEnsemblTools } from '../../server/tools/ensembl.js';
import { registerConfigureTool } from '../../server/tools/configure.js';
import { connectionManager } from '../../connections/manager.js';

/** A captured server→client JSON-RPC message (requests/responses included). */
export interface CapturedMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
}

/** The params of a notifications/progress message. */
export interface ProgressCapture {
  progressToken: string | number;
  progress: number;
  total?: number;
  message?: string;
}

export interface CallToolOptions {
  /**
   * Client-chosen progressToken, sent via the request's `_meta` exactly as a
   * spec-native client would (the SDK auto-assigns its own token only when
   * `onProgress` is used — these two modes are mutually exclusive).
   */
  progressToken?: string | number;
  /**
   * SDK-native progress reception: passes `onprogress` in RequestOptions so
   * the SDK attaches its auto-generated progressToken and invokes this on
   * every notifications/progress for the call.
   */
  onProgress?: (progress: { progress: number; total?: number; message?: string }) => void;
  /** Client-side cancellation; the SDK sends notifications/cancelled and rejects locally. */
  signal?: AbortSignal;
  /** Return the raw CallToolResult instead of throwing on isError / JSON-parsing. */
  raw?: boolean;
  /** Per-request timeout in ms (SDK default 60 s). */
  timeoutMs?: number;
}

export type ToolClient = {
  readonly client: Client;
  callTool: (name: string, args?: Record<string, unknown>, options?: CallToolOptions) => Promise<unknown>;
  /** Every server→client message observed since connect (copy). */
  capturedMessages: () => CapturedMessage[];
  /** Only notifications/progress params, in arrival order. */
  progressNotifications: () => ProgressCapture[];
  close: () => Promise<void>;
};

/**
 * Connect an SDK Client to an McpServer over InMemoryTransport with a tap on
 * the client-side message stream, plus a callTool wrapper supporting
 * progressToken injection, SDK-native onprogress, cancellation signals, and a
 * raw-result mode. Backward-compatible superset of the previous harness.
 */
export async function connectToolClient(server: McpServer): Promise<ToolClient> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const captured: CapturedMessage[] = [];
  const base = clientTransport.onmessage;
  if (base) {
    clientTransport.onmessage = (message, extra) => {
      captured.push(message as CapturedMessage);
      base(message, extra);
    };
  }
  return {
    client,
    callTool: async (name, args = {}, options = {}) => {
      const params: Record<string, unknown> = { name, arguments: args };
      if (options.progressToken !== undefined) {
        params._meta = { progressToken: options.progressToken };
      }
      const requestOptions: RequestOptions = {};
      if (options.signal) requestOptions.signal = options.signal;
      if (options.onProgress) requestOptions.onprogress = options.onProgress;
      if (options.timeoutMs !== undefined) requestOptions.timeout = options.timeoutMs;
      const result = (await client.callTool(params as never, undefined, requestOptions)) as {
        content: Array<{ type: string; text: string }>;
        isError?: boolean;
      };
      if (options.raw) return result;
      if (result.isError) {
        throw new Error(`Tool '${name}' returned error: ${result.content[0]?.text}`);
      }
      return JSON.parse(result.content[0].text);
    },
    capturedMessages: () => captured.slice(),
    progressNotifications: () =>
      captured
        .filter((m) => m.method === 'notifications/progress')
        .map((m) => (m.params ?? {}) as unknown as ProgressCapture),
    close: async () => {
      await client.close();
    },
  };
}

export type McpTestHarness = {
  callTool: (name: string, args?: Record<string, unknown>, options?: CallToolOptions) => Promise<unknown>;
  listTools: () => Promise<unknown>;
  capturedMessages: () => CapturedMessage[];
  progressNotifications: () => ProgressCapture[];
  close: () => Promise<void>;
};

export async function createMcpTestHarness(): Promise<McpTestHarness> {
  const server = new McpServer({ name: 'test-biomcp', version: '1.0.0' });

  registerGeneTools(server);
  registerVariantTools(server);
  registerDrugTools(server);
  registerDiseaseTools(server);
  registerArticleTools(server);
  registerTrialTools(server);
  registerUtilityTools(server);
  registerPdbTools(server);
  registerPatentTools(server);
  registerGeoTools(server);
  registerSraTools(server);
  registerGenbankTools(server);
  registerGtexTools(server);
  registerEnsemblTools(server);
  registerConfigureTool(server);

  const toolClient = await connectToolClient(server);

  return {
    callTool: toolClient.callTool,
    listTools: () => toolClient.client.listTools(),
    capturedMessages: toolClient.capturedMessages,
    progressNotifications: toolClient.progressNotifications,
    close: async () => {
      await toolClient.close();
      connectionManager.closeAll();
    },
  };
}
