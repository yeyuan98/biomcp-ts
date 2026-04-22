# MCP TypeScript SDK v1.x — Technical Reference

> Reference document for implementing a TypeScript MCP server using the `@modelcontextprotocol/sdk` v1.x branch.
> SDK Version: 1.29.0 | Branch: v1.x | Package: `@modelcontextprotocol/sdk`

---

## Table of Contents

1. [Package Structure & Imports](#1-package-structure--imports)
2. [Server Architecture Overview](#2-server-architecture-overview)
3. [Transport Layer — STDIO Mode](#3-transport-layer--stdio-mode)
4. [High-Level McpServer API](#4-high-level-mcpserver-api)
5. [Low-Level Server API](#5-low-level-server-api)
6. [Protocol Base Class](#6-protocol-base-class)
7. [Tool Registration](#7-tool-registration)
8. [Resource Registration](#8-resource-registration)
9. [Prompt Registration](#9-prompt-registration)
10. [Zod Schema System](#10-zod-schema-system)
11. [Validation System](#11-validation-system)
12. [Capability Negotiation](#12-capability-negotiation)
13. [Error Handling](#13-error-handling)
14. [Completions System](#14-completions-system)
15. [Logging & Notifications](#15-logging--notifications)
16. [Complete STDIO Server Pattern](#16-complete-stdio-server-pattern)
17. [Type Reference](#17-type-reference)
18. [Appendix: File Map](#18-appendix-file-map)

---

## 1. Package Structure & Imports

### 1.1 Import Paths

```typescript
// High-level server API (recommended for most use cases)
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// Low-level server class
import { Server } from '@modelcontextprotocol/sdk/server';

// STDIO transport
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

// Streamable HTTP transport
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

// Protocol types (Zod schemas and inferred types)
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  CallToolResultSchema,
  // ... etc
} from '@modelcontextprotocol/sdk/types.js';

// Zod (user's choice of v3 or v4)
import { z } from 'zod';
// OR
import * as z from 'zod/v4';
```

### 1.2 Export Map

| Import Path | Provides |
|-------------|----------|
| `@modelcontextprotocol/sdk` | Root entry |
| `@modelcontextprotocol/sdk/server` | `Server`, `ServerOptions`, re-exported types |
| `@modelcontextprotocol/sdk/server/mcp.js` | `McpServer`, `ResourceTemplate`, registered types |
| `@modelcontextprotocol/sdk/server/stdio.js` | `StdioServerTransport` |
| `@modelcontextprotocol/sdk/types.js` | All Zod schemas and TypeScript types |
| `@modelcontextprotocol/sdk/validation/ajv` | `AjvJsonSchemaValidator` |
| `@modelcontextprotocol/sdk/validation/cfworker` | `CfWorkerJsonSchemaValidator` |
| `@modelcontextprotocol/sdk/experimental` | Experimental features (tasks) |

### 1.3 Dependencies

| Dependency | Type | Purpose |
|------------|------|---------|
| `zod` (^3.25 or ^4.0) | Direct + Required peer | Schema definition for tools/prompts |
| `ajv` + `ajv-formats` | Direct | Default JSON Schema validation |
| `zod-to-json-schema` | Direct | Zod v3 to JSON Schema conversion |
| `json-schema-typed` | Direct | JSON Schema TypeScript types |
| `express`, `hono` | Direct | HTTP server integration |
| `cross-spawn` | Direct | Child process spawning (client STDIO) |

---

## 2. Server Architecture Overview

### 2.1 Class Hierarchy

```
Protocol<SendRequestT, SendNotificationT, SendResultT>  (abstract, src/shared/protocol.ts)
  └── Server<RequestT, NotificationT, ResultT>           (low-level, src/server/index.ts)

McpServer                                                 (high-level, src/server/mcp.ts)
  └── wraps Server internally via `this.server`
      (composition, NOT inheritance)
```

### 2.2 Transport Interface

```
Transport (interface, src/shared/transport.ts)
  ├── StdioServerTransport      (src/server/stdio.ts)
  ├── StreamableHTTPServerTransport  (src/server/streamableHttp.ts)
  ├── SSEServerTransport         (src/server/sse.ts) — deprecated
  ├── WebStandardStreamableHTTPServerTransport (src/server/webStandardStreamableHttp.ts)
  └── InMemoryTransport          (src/inMemory.ts) — testing only
```

### 2.3 Data Flow

```
Client Process                    Server Process
─────────────                     ─────────────
                 stdin ──────> stdin
                                  │
                                  ▼
                              StdioServerTransport
                                  │
                                  ▼
                              Protocol._onmessage()
                                  │
                        ┌─────────┼─────────┐
                        ▼         ▼         ▼
                    _onrequest  _onresponse _onnotification
                        │
                        ▼
                  Registered Handler
                        │
                        ▼
                  CallToolResult / etc.
                        │
                        ▼
                  Protocol.send()
                        │
                        ▼
              StdioServerTransport.send()
                        │
                 stdout ──────> stdout
```

---

## 3. Transport Layer — STDIO Mode

### 3.1 StdioServerTransport

**File**: `src/server/stdio.ts` (~92 lines)

```typescript
export class StdioServerTransport implements Transport {
  constructor(
    private _stdin: Readable = process.stdin,
    private _stdout: Writable = process.stdout
  );

  // Transport interface callbacks
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  // sessionId is undefined for STDIO (no session management)
  // setProtocolVersion is not implemented

  async start(): Promise<void>;
  async send(message: JSONRPCMessage): Promise<void>;
  async close(): Promise<void>;
}
```

**Key characteristics**:
- Defaults to `process.stdin` / `process.stdout`
- Messages are newline-delimited JSON (NDJSON): `JSON.stringify(message) + '\n'`
- `start()` attaches data/error listeners to stdin (resolves immediately)
- `send()` writes to stdout with backpressure handling (waits for `drain` event if buffer full)
- `close()` removes listeners, conditionally pauses stdin (only if no other listeners), clears buffer
- No session management — `sessionId` is always `undefined`
- Double-start protection: throws if `start()` called twice

### 3.2 Wire Format

```
STDIN:  {"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"my-tool","arguments":{}}}\n
STDOUT: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"result"}]}}\n
```

Messages are validated through Zod schemas on deserialization:
1. `JSON.parse(line)` → raw object
2. `JSONRPCMessageSchema.parse(raw)` → validated `JSONRPCMessage`

### 3.3 Startup Sequence

```
1. const transport = new StdioServerTransport();
2. const server = new McpServer({ name, version });
3. await server.connect(transport);
   └── Protocol.connect():
       a. Store transport reference
       b. Wrap transport.onclose/onerror/onmessage
       c. Route messages: response→_onresponse, request→_onrequest, notification→_onnotification
       d. Call transport.start()
           └── Attach stdin data/error listeners
4. SERVER IS LIVE — listening on stdin
```

**Critical rules for STDIO servers**:
- `console.log()` writes to stdout = transport channel → **use `console.error()` for debug output**
- `connect()` automatically calls `transport.start()` — do NOT call `start()` yourself
- Server runs until stdin is closed (client process terminates)

---

## 4. High-Level McpServer API

**File**: `src/server/mcp.ts`

### 4.1 Constructor

```typescript
class McpServer {
  public readonly server: Server;  // access to low-level Server

  constructor(
    serverInfo: Implementation,  // { name: string; version: string; title?: string }
    options?: ServerOptions
  );
}

type ServerOptions = ProtocolOptions & {
  capabilities?: ServerCapabilities;
  instructions?: string;          // Server instructions sent during initialization
  jsonSchemaValidator?: jsonSchemaValidator;
};

type ProtocolOptions = {
  enforceStrictCapabilities?: boolean;
  debouncedNotificationMethods?: string[];
  taskStore?: TaskStore;
  taskMessageQueue?: TaskMessageQueue;
  defaultTaskPollInterval?: number;
  maxTaskQueueSize?: number;
};
```

### 4.2 Connection Methods

```typescript
async connect(transport: Transport): Promise<void>;
async close(): Promise<void>;
isConnected(): boolean;  // server.transport !== undefined
```

### 4.3 Tool Registration

#### `registerTool()` (preferred)

```typescript
registerTool<OutputArgs, InputArgs>(
  name: string,
  config: {
    title?: string;
    description?: string;
    inputSchema?: InputArgs;      // ZodRawShapeCompat | AnySchema | undefined
    outputSchema?: OutputArgs;    // ZodRawShapeCompat | AnySchema | undefined
    annotations?: ToolAnnotations;
    _meta?: Record<string, unknown>;
  },
  cb: ToolCallback<InputArgs>
): RegisteredTool;
```

#### `tool()` (deprecated in favor of registerTool)

6 overloads covering combinations of:
- `(name, callback)` — no params, no description
- `(name, description, callback)`
- `(name, paramsSchemaOrAnnotations, callback)` — accepts EITHER a Zod shape OR `ToolAnnotations`
- `(name, description, paramsSchemaOrAnnotations, callback)` — same union
- `(name, paramsSchema, annotations, callback)` — both params and annotations
- `(name, description, paramsSchema, annotations, callback)` — full form

Note: Overloads 3-4 accept a union type `Args | ToolAnnotations` — if the second arg looks like a Zod shape, it's treated as params; if it has `readOnlyHint`, `destructiveHint`, etc., it's treated as annotations.

#### ToolCallback Type

```typescript
// Callback type adapts based on inputSchema:
type ToolCallback<Args> =
  Args extends ZodRawShapeCompat
    ? (args: ShapeOutput<Args>, extra: RequestHandlerExtra) => CallToolResult | Promise<CallToolResult>
    : Args extends AnySchema
      ? (args: SchemaOutput<Args>, extra: RequestHandlerExtra) => CallToolResult | Promise<CallToolResult>
      : (extra: RequestHandlerExtra) => CallToolResult | Promise<CallToolResult>;
```

#### RegisteredTool Type

```typescript
type RegisteredTool = {
  title?: string;
  description?: string;
  inputSchema?: AnySchema;
  outputSchema?: AnySchema;
  annotations?: ToolAnnotations;
  execution?: ToolExecution;                // { taskSupport?: 'required' | 'optional' | 'forbidden' }
  _meta?: Record<string, unknown>;
  handler: AnyToolHandler;                  // The registered handler function
  enabled: boolean;
  enable(): void;
  disable(): void;
  update(updates: { ... }): void;
  remove(): void;
};
```

### 4.4 Resource Registration

#### `registerResource()` (preferred)

```typescript
registerResource(
  name: string,
  uri: string,                    // fixed URI
  config: ResourceMetadata,       // { mimeType?, description?, ... }
  readCallback: ReadResourceCallback
): RegisteredResource;

registerResource(
  name: string,
  uriOrTemplate: ResourceTemplate,  // URI template
  config: ResourceMetadata,
  readCallback: ReadResourceTemplateCallback
): RegisteredResourceTemplate;
```

#### ResourceCallback Types

```typescript
type ReadResourceCallback = (
  uri: URL,
  extra: RequestHandlerExtra
) => ReadResourceResult | Promise<ReadResourceResult>;

type ReadResourceTemplateCallback = (
  uri: URL,
  variables: Record<string, string | string[]>,
  extra: RequestHandlerExtra
) => ReadResourceResult | Promise<ReadResourceResult>;

type ReadResourceResult = {
  contents: Array<TextResourceContents | BlobResourceContents>;
};

type ResourceMetadata = Omit<Resource, 'uri' | 'name'>;
// = { title?, description?, mimeType?, size?, annotations?, _meta? }
```

### 4.5 Prompt Registration

#### `registerPrompt()` (preferred)

```typescript
registerPrompt<Args extends PromptArgsRawShape>(
  name: string,
  config: {
    title?: string;
    description?: string;
    argsSchema?: Args;           // ZodRawShapeCompat
  },
  cb: PromptCallback<Args>
): RegisteredPrompt;
```

#### PromptCallback Type

```typescript
type PromptCallback<Args> =
  Args extends PromptArgsRawShape
    ? (args: ShapeOutput<Args>, extra: RequestHandlerExtra) => GetPromptResult | Promise<GetPromptResult>
    : (extra: RequestHandlerExtra) => GetPromptResult | Promise<GetPromptResult>;

type GetPromptResult = {
  description?: string;
  messages: Array<{
    role: 'user' | 'assistant';
    content: ContentBlock;
  }>;
};
```

### 4.6 Notification Helpers

```typescript
async sendLoggingMessage(
  params: LoggingMessageNotification['params'],
  sessionId?: string
): Promise<void>;

sendToolListChanged(): void;     // only sends if connected
sendResourceListChanged(): void;
sendPromptListChanged(): void;
```

### 4.7 Accessing Low-Level Server

```typescript
const mcpServer = new McpServer({ name: 'my-server', version: '1.0.0' });

// Access the underlying Server for advanced operations
await mcpServer.server.createMessage({ ... });     // LLM sampling
await mcpServer.server.elicitInput({ ... });       // Elicitation
await mcpServer.server.listRoots();                // Client roots
```

### 4.8 Experimental Tasks

```typescript
// Access experimental task features
mcpServer.experimental.tasks.registerToolTask('long-query', { ... }, async (args, extra) => {
  // Long-running task handler
});
```

---

## 5. Low-Level Server API

**File**: `src/server/index.ts`

### 5.1 Constructor

```typescript
class Server<
  RequestT extends Request = Request,
  NotificationT extends Notification = Notification,
  ResultT extends Result = Result
> extends Protocol<ServerRequest | RequestT, ServerNotification | NotificationT, ServerResult | ResultT> {

  constructor(
    private _serverInfo: Implementation,
    options?: ServerOptions
  );
}
```

### 5.2 Public Methods

```typescript
// Capability registration (BEFORE connect only)
registerCapabilities(capabilities: ServerCapabilities): void;

// Client info (available after initialization)
getClientCapabilities(): ClientCapabilities | undefined;
getClientVersion(): Implementation | undefined;

// Callbacks
oninitialized?: () => void;

// Ping client
async ping(): Promise<{}>;

// LLM Sampling (server → client)
async createMessage(params: CreateMessageRequestParamsBase, options?): Promise<CreateMessageResult>;
async createMessage(params: CreateMessageRequestParamsWithTools, options?): Promise<CreateMessageResultWithTools>;

// Elicitation (server → client)
async elicitInput(
  params: ElicitRequestFormParams | ElicitRequestURLParams,
  options?: RequestOptions
): Promise<ElicitResult>;

// List client roots
async listRoots(params?, options?): Promise<ListRootsResult>;

// Logging
async sendLoggingMessage(params, sessionId?): Promise<void>;
// NOTE: silently drops messages if logging capability not set or level below client's threshold

// Elicitation completion notifier (for URL-mode elicitation)
createElicitationCompletionNotifier(elicitationId: string, options?): () => Promise<void>;

// Resource/Tool/Prompt change notifications
async sendResourceUpdated(params): Promise<void>;
async sendResourceListChanged(): Promise<void>;
async sendToolListChanged(): Promise<void>;
async sendPromptListChanged(): Promise<void>;
```

### 5.3 Request Handler Registration

```typescript
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  // request.params.name - tool name
  // request.params.arguments - tool arguments
  // extra.signal - AbortSignal
  // extra.sessionId - session identifier
  // extra.sendNotification() - send notification back
  // extra.sendRequest() - send request to client
  return {
    content: [{ type: 'text', text: 'result' }]
  };
});
```

---

## 6. Protocol Base Class

**File**: `src/shared/protocol.ts` (~1682 lines)

### 6.1 Key Types

```typescript
type ProtocolOptions = {
  enforceStrictCapabilities?: boolean;        // default false
  debouncedNotificationMethods?: string[];
  taskStore?: TaskStore;
  taskMessageQueue?: TaskMessageQueue;
  defaultTaskPollInterval?: number;           // default 5000ms
  maxTaskQueueSize?: number;
};

type RequestOptions = {
  onprogress?: ProgressCallback;
  signal?: AbortSignal;
  timeout?: number;                           // default: 60000ms
  resetTimeoutOnProgress?: boolean;
  maxTotalTimeout?: number;
  task?: TaskCreationParams;                  // for task-augmented requests
  relatedTask?: RelatedTaskMetadata;          // associate with existing task
};

type RequestHandlerExtra<SendRequestT, SendNotificationT> = {
  signal: AbortSignal;
  authInfo?: AuthInfo;
  sessionId?: string;
  _meta?: RequestMeta;                        // includes progressToken
  requestId: RequestId;
  taskId?: string;                            // task ID if request is task-augmented
  taskStore?: RequestTaskStore;               // scoped task storage interface
  taskRequestedTtl?: number;
  requestInfo?: RequestInfo;                  // original HTTP request info
  sendNotification: (notification: SendNotificationT) => Promise<void>;
  sendRequest: <U extends AnySchema>(
    request: SendRequestT,
    resultSchema: U,
    options?: TaskRequestOptions
  ) => Promise<SchemaOutput<U>>;
  closeSSEStream?: () => void;
};

const DEFAULT_REQUEST_TIMEOUT_MSEC = 60000;
```

### 6.2 Key Methods

```typescript
abstract class Protocol<SendRequestT, SendNotificationT, SendResultT> {
  // Connection
  async connect(transport: Transport): Promise<void>;
  async close(): Promise<void>;

  // Sending
  request<T>(request, resultSchema, options?): Promise<SchemaOutput<T>>;
  async notification(notification, options?): Promise<void>;

  // Handler registration
  setRequestHandler<T>(schema, handler): void;
  removeRequestHandler(method: string): void;
  assertCanSetRequestHandler(method: string): void;  // guard against duplicate handler registration
  setNotificationHandler<T>(schema, handler): void;
  removeNotificationHandler(method: string): void;

  // Transport access
  get transport(): Transport | undefined;

  // Callbacks
  onclose?: () => void;
  onerror?: (error: Error) => void;
  fallbackRequestHandler?: (request: JSONRPCRequest, extra: RequestHandlerExtra) => Promise<SendResultT>;
  fallbackNotificationHandler?: (notification: Notification) => Promise<void>;
}
```

### 6.3 Built-in Handlers (auto-registered in constructor)

- `CancelledNotificationSchema` → sends abort to pending request handlers
- `ProgressNotificationSchema` → routes to registered progress callbacks
- `PingRequestSchema` → auto-responds with empty result `{}`
- Task handlers if `taskStore` is provided

---

## 7. Tool Registration

### 7.1 Input Schema Forms

Three valid forms for `inputSchema`:

```typescript
// 1. Undefined (no parameters)
registerTool('ping', { description: 'Ping' }, async (extra) => { ... });

// 2. Raw Zod shape (most common)
registerTool('search', {
  description: 'Search articles',
  inputSchema: {
    query: z.string().describe('Search query'),
    limit: z.number().int().min(1).max(100).optional().describe('Max results')
  }
}, async ({ query, limit }) => { ... });

// 3. Full Zod object schema
registerTool('search', {
  description: 'Search articles',
  inputSchema: z.object({
    query: z.string().describe('Search query'),
    limit: z.number().int().min(1).max(100).optional()
  })
}, async ({ query, limit }) => { ... });
```

### 7.2 Output Schema

```typescript
registerTool('get_weather', {
  description: 'Get weather',
  inputSchema: { city: z.string() },
  outputSchema: {
    temperature: z.number(),
    conditions: z.enum(['sunny', 'cloudy', 'rainy'])
  }
}, async ({ city }) => ({
  content: [{ type: 'text', text: JSON.stringify({ temperature: 22, conditions: 'sunny' }) }],
  structuredContent: { temperature: 22, conditions: 'sunny' }
}));
```

### 7.3 Tool Annotations

```typescript
type ToolAnnotations = {
  title?: string;
  readOnlyHint?: boolean;       // default false
  destructiveHint?: boolean;    // default true
  idempotentHint?: boolean;     // default false
  openWorldHint?: boolean;      // default true
};
```

### 7.4 CallToolResult Structure

```typescript
type CallToolResult = {
  content: ContentBlock[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'audio'; data: string; mimeType: string }
  | { type: 'resource_link'; ... }       // Resource reference
  | { type: 'resource'; resource: ... }; // Embedded resource
```

### 7.5 Tool Error Handling

Inside the `tools/call` handler in McpServer:
- Tool not found / disabled → `McpError(ErrorCode.InvalidParams)`
- Input validation failure → `McpError(ErrorCode.InvalidParams, 'Input validation error: ...')`
- Output validation failure (missing structuredContent with outputSchema) → `McpError(ErrorCode.InvalidParams)`
- Tool handler throws non-McpError → wrapped as `{ content: [{ type: 'text', text: error.message }], isError: true }`
- `UrlElicitationRequiredError` → propagated unwrapped

### 7.6 Lazy Initialization

McpServer uses lazy initialization — request handlers and capabilities are registered only when the first tool/resource/prompt is registered:

- `setToolRequestHandlers()` — called on first `tool()` / `registerTool()`
  - Registers `tools/list` and `tools/call` handlers
  - Calls `server.registerCapabilities({ tools: { listChanged: true } })`
- Sends `notifications/tools/list_changed` if already connected

---

## 8. Resource Registration

### 8.1 Static Resources

```typescript
server.registerResource(
  'greeting',
  'resource://greeting',
  { mimeType: 'text/plain', description: 'A greeting resource' },
  async (uri) => ({
    contents: [{ uri: uri.toString(), text: 'Hello, World!' }]
  })
);
```

### 8.2 Template Resources

```typescript
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';

server.registerResource(
  'user-profile',
  new ResourceTemplate('resource://users/{userId}/profile', {
    list: async (extra) => ({
      resources: [
        { uri: 'resource://users/123/profile', name: 'Profile 123' }
      ]
    }),
    complete: {
      userId: async (value) => ['123', '456', '789'].filter(id => id.startsWith(value))
    }
  }),
  { description: 'User profile' },
  async (uri, variables) => ({
    contents: [{ uri: uri.toString(), text: `Profile for user ${variables.userId}` }]
  })
);
```

### 8.3 ReadResourceResult

```typescript
type ReadResourceResult = {
  contents: Array<
    | { uri: string; mimeType?: string; text: string }     // Text content
    | { uri: string; mimeType?: string; blob: string }     // Base64 binary content
  >;
};
```

---

## 9. Prompt Registration

### 9.1 Basic Prompt

```typescript
server.registerPrompt(
  'greeting-template',
  {
    description: 'A greeting prompt template',
    argsSchema: { name: z.string().describe('Person to greet') }
  },
  async ({ name }) => ({
    messages: [{
      role: 'user',
      content: { type: 'text', text: `Please greet ${name} warmly.` }
    }]
  })
);
```

### 9.2 Prompt with Completions

```typescript
import { completable } from '@modelcontextprotocol/sdk/server/completable.js';

server.registerPrompt(
  'language-greeting',
  {
    description: 'Greet in a specific language',
    argsSchema: {
      language: completable(
        z.string().describe('Language'),
        async (value) => ['en', 'es', 'fr', 'de'].filter(l => l.startsWith(value))
      ),
      name: z.string()
    }
  },
  async ({ language, name }) => ({ ... })
);
```

---

## 10. Zod Schema System

### 10.1 Dual Version Support

The SDK uses Zod v4 internally for protocol types (`import * as z from 'zod/v4'` in `types.ts`) and `zod/v4-mini` for runtime operations in the compatibility layer (`safeParse`, `objectFromShape`, etc. in `zod-compat.ts`). User code can pass either Zod v3 or v4 schemas as tool parameter definitions.

### 10.2 Unified Types (zod-compat.ts)

```typescript
type AnySchema = z3.ZodTypeAny | z4.$ZodType;
type AnyObjectSchema = z3.AnyZodObject | z4.$ZodObject | AnySchema;
type ZodRawShapeCompat = Record<string, AnySchema>;

type SchemaOutput<S> = S extends z3.ZodTypeAny ? z3.infer<S>
                      : S extends z4.$ZodType ? z4.output<S>
                      : never;

type ShapeOutput<Shape extends ZodRawShapeCompat> = {
  [K in keyof Shape]: SchemaOutput<Shape[K]>;
};
```

### 10.3 Conversion Pipeline

```
User's Zod Schema (v3 or v4)
        │
        ▼
  normalizeObjectSchema()    ── handles raw shapes, wraps with objectFromShape()
        │
        ▼
  toJsonSchemaCompat()       ── v4: zod/v4-mini.toJSONSchema()
        │                       v3: zod-to-json-schema library
        ▼
  JSON Schema Draft 2020-12  ── returned in tools/list response
```

### 10.4 Runtime Detection

```typescript
function isZ4Schema(s: AnySchema): s is z4.$ZodType {
  return !!s._zod;  // _zod exists only on v4 schemas
}
```

---

## 11. Validation System

### 11.1 Provider Interface

```typescript
interface jsonSchemaValidator {
  getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T>;
}

type JsonSchemaValidator<T> = (input: unknown) => JsonSchemaValidatorResult<T>;

type JsonSchemaValidatorResult<T> =
  | { valid: true; data: T; errorMessage: undefined }
  | { valid: false; data: undefined; errorMessage: string };
```

### 11.2 Two Validation Paths

| Context | Validation Method | Used By |
|---------|-------------------|---------|
| Tool input/output (server-side) | Zod `safeParseAsync()` | McpServer |
| Tool output (client-side) | `jsonSchemaValidator` | Client |
| Elicitation response | `jsonSchemaValidator` | Server |

### 11.3 Default Validator

```typescript
// NOTE: use 'validation/ajv' (no .js) — package.json maps this to ajv-provider.js
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';

// Default configuration (Ajv is bundled)
new Ajv({ strict: false, validateFormats: true, validateSchema: false, allErrors: true })
// Plus ajv-formats for format keywords
```

---

## 12. Capability Negotiation

### 12.1 ServerCapabilities

```typescript
type ServerCapabilities = {
  experimental?: Record<string, unknown>;
  logging?: {};
  completions?: {};
  prompts?: { listChanged?: boolean };
  resources?: { subscribe?: boolean; listChanged?: boolean };
  tools?: { listChanged?: boolean };
  tasks?: ServerTasksCapability;
  extensions?: Record<string, unknown>;
};
```

### 12.2 Capability Assertions

When the server wants to send a request to the client:

| Method | Required Client Capability |
|--------|---------------------------|
| `sampling/createMessage` | `clientCapabilities.sampling` (basic); `clientCapabilities.sampling.tools` (with tools) |
| `elicitation/create` (form) | `clientCapabilities.elicitation.form` |
| `elicitation/create` (url) | `clientCapabilities.elicitation.url` |
| `roots/list` | `clientCapabilities.roots` |

When registering request handlers:

| Method | Required Server Capability |
|--------|---------------------------|
| `completion/complete` | `capabilities.completions` |
| `logging/setLevel` | `capabilities.logging` |
| `prompts/get`, `prompts/list` | `capabilities.prompts` |
| `resources/list`, `resources/read`, etc. | `capabilities.resources` |
| `tools/call`, `tools/list` | `capabilities.tools` |

### 12.3 Automatic Capability Registration

McpServer automatically adds capabilities when features are registered:
- First tool registered → `{ tools: { listChanged: true } }`
- First resource registered → `{ resources: { listChanged: true } }`
- First prompt registered → `{ prompts: { listChanged: true } }`
- Completions used → `{ completions: {} }`

### 12.4 Initialization Flow

```
Client                          Server
  │                               │
  │── InitializeRequest ─────────►│
  │   { protocolVersion,          │
  │     capabilities,             │
  │     clientInfo }              │
  │                               │ Stores clientCapabilities
  │                               │ Stores clientVersion
  │◄── InitializeResult ──────────│
  │   { protocolVersion,          │
  │     capabilities,             │
  │     serverInfo,               │
  │     instructions? }           │
  │                               │
  │── InitializedNotification ───►│
  │                               │ Fires server.oninitialized()
  │                               │
  │    [READY FOR REQUESTS]       │
```

---

## 13. Error Handling

### 13.1 McpError Class

```typescript
class McpError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown
  );
}

enum ErrorCode {
  ConnectionClosed = -32000,
  RequestTimeout   = -32001,
  ParseError       = -32700,
  InvalidRequest   = -32600,
  MethodNotFound   = -32601,
  InvalidParams    = -32602,
  InternalError    = -32603,
  UrlElicitationRequired = -32042,
}
```

### 13.2 Specialized Error Classes

```typescript
// URL elicitation required — thrown by tools that need URL-mode elicitation
class UrlElicitationRequiredError extends McpError {
  constructor(elicitations: ElicitRequestURLParams[], message?: string);
  get elicitations(): ElicitRequestURLParams[];
}

// Static factory on McpError
McpError.fromError(code: number, message: string, data?: unknown): McpError;
```

### 13.2 Error Response Format

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32602,
    "message": "Invalid params",
    "data": "Tool not found: my-tool"
  }
}
```

### 13.3 Recommended Error Pattern in Tools

```typescript
// For expected errors (user-facing, LLM can self-correct):
throw new Error('Gene symbol not found');  // → wrapped as isError: true

// For protocol errors:
throw new McpError(ErrorCode.InvalidParams, 'Missing required parameter');
```

---

## 14. Completions System

### 14.1 Completable Wrapper

```typescript
import { completable } from '@modelcontextprotocol/sdk/server/completable.js';

const languageSchema = completable(
  z.string().describe('Programming language'),
  async (value, context) => {
    const languages = ['typescript', 'python', 'rust', 'go', 'java'];
    return languages.filter(l => l.startsWith(value));
  }
);
```

### 14.2 How It Works

Uses a `Symbol.for('mcp.completable')` key to attach completion metadata to Zod schemas:

```typescript
const COMPLETABLE_SYMBOL: unique symbol = Symbol.for('mcp.completable');

function completable<T extends AnySchema>(schema: T, complete: CompleteCallback<T>): CompletableSchema<T>;
function isCompletable(schema: unknown): schema is CompletableSchema<AnySchema>;
function getCompleter<T extends AnySchema>(schema: T): CompleteCallback<T> | undefined;
```

### 14.3 Completion Result

```typescript
type CompleteResult = {
  completion: {
    values: string[];     // capped at 100
    total: number;
    hasMore: boolean;
  };
};
```

---

## 15. Logging & Notifications

### 15.1 Server Logging

```typescript
// Requires capabilities: { logging: {} }
await server.sendLoggingMessage({
  level: 'info',         // 'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critical' | 'alert' | 'emergency'
  logger: 'my-logger',   // optional
  data: { message: 'Processing started' }
});
```

### 15.2 Change Notifications

```typescript
// Automatically sent when tools/resources/prompts are added/removed/updated
server.sendToolListChanged();
server.sendResourceListChanged();
server.sendPromptListChanged();
```

### 15.3 Progress Notifications in Tools

```typescript
registerTool('long-task', { description: '...', inputSchema: { n: z.number() } },
  async ({ n }, extra) => {
    for (let i = 1; i <= n; i++) {
      if (extra.signal.aborted) {
        return { content: [{ type: 'text', text: 'Cancelled' }], isError: true };
      }
      if (extra._meta?.progressToken !== undefined) {
        await extra.sendNotification({
          method: 'notifications/progress',
          params: {
            progressToken: extra._meta.progressToken,
            progress: i,
            total: n
          }
        });
      }
      await new Promise(r => setTimeout(r, 100));
    }
    return { content: [{ type: 'text', text: 'Done' }] };
  }
);
```

---

## 16. Complete STDIO Server Pattern

### 16.1 Minimal Server

```typescript
#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({
  name: 'my-biomedical-server',
  version: '1.0.0'
});

server.registerTool(
  'search-genes',
  {
    description: 'Search for genes by symbol or name',
    inputSchema: {
      query: z.string().describe('Gene symbol or name to search for'),
      limit: z.number().int().min(1).max(50).optional().describe('Max results')
    }
  },
  async ({ query, limit }) => {
    return {
      content: [{ type: 'text', text: JSON.stringify({ results: [] }) }]
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(error => {
  console.error('Server error:', error);
  process.exit(1);
});
```

### 16.2 Full-Featured Server Pattern

```typescript
#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { completable } from '@modelcontextprotocol/sdk/server/completable.js';
import { z } from 'zod';

const server = new McpServer(
  { name: 'biomcp-server', version: '1.0.0' },
  { capabilities: { logging: {} } }
);

// --- Tools ---
server.registerTool('search', {
  description: 'Search biomedical data',
  inputSchema: {
    domain: completable(
      z.enum(['gene', 'variant', 'drug', 'disease', 'article', 'trial']),
      async (v) => ['gene', 'variant', 'drug', 'disease', 'article', 'trial']
    ),
    query: z.string().describe('Search query'),
    limit: z.number().int().min(1).max(100).optional()
  },
  annotations: { readOnlyHint: true, openWorldHint: true }
}, async ({ domain, query, limit }, extra) => {
  // Implement search logic
  return {
    content: [{ type: 'text', text: JSON.stringify({ domain, query, results: [] }) }]
  };
});

// --- Resources ---
server.registerResource(
  'info',
  'resource://biomcp/info',
  { description: 'Server information', mimeType: 'application/json' },
  async (uri) => ({
    contents: [{ uri: uri.toString(), text: JSON.stringify({ version: '1.0.0' }) }]
  })
);

// --- Prompts ---
server.registerPrompt('analyze-gene', {
  description: 'Analyze a gene',
  argsSchema: { gene: z.string().describe('Gene symbol') }
}, async ({ gene }) => ({
  messages: [{
    role: 'user',
    content: { type: 'text', text: `Analyze gene ${gene}` }
  }]
}));

// --- Start ---
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(error => {
  console.error('Server error:', error);
  process.exit(1);
});
```

---

## 17. Type Reference

### 17.1 Implementation

```typescript
type Implementation = {
  name: string;
  title?: string;
  version: string;
  websiteUrl?: string;
  description?: string;
};
```

### 17.2 ContentBlock Union

```typescript
type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'audio'; data: string; mimeType: string }
  | ResourceLink
  | EmbeddedResource;
```

### 17.3 JSON-RPC Message Types

```typescript
type JSONRPCMessage =
  | { jsonrpc: '2.0'; id: RequestId; method: string; params?: any }           // Request
  | { jsonrpc: '2.0'; method: string; params?: any }                          // Notification
  | { jsonrpc: '2.0'; id: RequestId; result: Result }                         // Result Response
  | { jsonrpc: '2.0'; id?: RequestId; error: { code: number; message: string; data?: any } }; // Error Response
```

### 17.4 Key Schema Constants

```typescript
// Tool schemas
CallToolRequestSchema
CallToolResultSchema
ListToolsRequestSchema
ListToolsResultSchema
ToolSchema
ToolAnnotationsSchema

// Resource schemas
ReadResourceRequestSchema
ReadResourceResultSchema
ListResourcesRequestSchema
ListResourcesResultSchema
ResourceSchema
ResourceTemplateSchema

// Prompt schemas
GetPromptRequestSchema
GetPromptResultSchema
ListPromptsRequestSchema
ListPromptsResultSchema
PromptSchema

// Initialization
InitializeRequestSchema
InitializeResultSchema
InitializedNotificationSchema

// Notifications
ToolListChangedNotificationSchema
ResourceListChangedNotificationSchema
ResourceUpdatedNotificationSchema
PromptListChangedNotificationSchema
ProgressNotificationSchema
CancelledNotificationSchema
LoggingMessageNotificationSchema

// Capabilities
ClientCapabilitiesSchema
ServerCapabilitiesSchema
```

---

## 18. Appendix: File Map

### Source Structure

```
src/
├── types.ts                          # Protocol types (Zod schemas + TS types)
├── spec.types.ts                     # Auto-generated spec types (pure TS)
├── inMemory.ts                       # InMemoryTransport for testing
│
├── server/
│   ├── index.ts                      # Server class (low-level)
│   ├── mcp.ts                        # McpServer class (high-level) + ResourceTemplate
│   ├── stdio.ts                      # StdioServerTransport
│   ├── streamableHttp.ts             # StreamableHTTPServerTransport
│   ├── sse.ts                        # SSEServerTransport (deprecated)
│   ├── webStandardStreamableHttp.ts  # Web-standard HTTP transport
│   ├── express.ts                    # Express integration helpers
│   ├── completable.ts                # Completion system
│   ├── zod-compat.ts                 # Zod v3/v4 compatibility
│   ├── zod-json-schema-compat.ts     # Zod → JSON Schema conversion
│   ├── middleware/                    # Server middleware
│   └── auth/                         # OAuth 2.0 server
│       ├── types.ts                  # AuthInfo, etc.
│       ├── provider.ts               # Auth provider interface
│       ├── router.ts                 # Auth route setup
│       ├── clients.ts                # OAuth client management
│       ├── errors.ts                 # Auth errors
│       ├── handlers/                 # Auth endpoint handlers
│       ├── middleware/               # Auth middleware (bearer, client auth)
│       └── providers/               # Auth providers
│
├── client/
│   ├── index.ts                      # Client class
│   ├── stdio.ts                      # StdioClientTransport
│   ├── streamableHttp.ts             # StreamableHTTPClientTransport
│   ├── sse.ts                        # SSE client transport
│   ├── auth.ts                       # OAuth client
│   ├── auth-extensions.ts            # Auth extensions
│   └── middleware.ts                 # Client middleware
│
├── shared/
│   ├── protocol.ts                   # Protocol base class
│   ├── transport.ts                  # Transport interface
│   ├── stdio.ts                      # Shared STDIO serialization
│   ├── uriTemplate.ts                # RFC 6570 URI templates
│   ├── auth.ts                       # Shared auth types
│   ├── auth-utils.ts                 # Auth utilities
│   ├── metadataUtils.ts             # Metadata helpers
│   ├── responseMessage.ts           # Response message types
│   └── toolNameValidation.ts        # Tool name validation
│
├── validation/
│   ├── index.ts                      # Re-exports type definitions
│   ├── types.ts                      # jsonSchemaValidator interface
│   ├── ajv-provider.ts              # Ajv validator (default)
│   └── cfworker-provider.ts         # Cloudflare Workers validator
│
├── experimental/
│   ├── index.ts                      # Re-exports tasks
│   └── tasks/
│       ├── index.ts                  # Barrel
│       ├── types.ts                  # Task types
│       ├── interfaces.ts             # TaskStore, ToolTaskHandler
│       ├── helpers.ts                # Capability assertions
│       ├── client.ts                 # Client-side tasks
│       ├── server.ts                 # Server-side tasks
│       ├── mcp-server.ts            # McpServer task integration
│       └── stores/
│           └── in-memory.ts          # InMemoryTaskStore
│
└── examples/
    ├── server/
    │   ├── progressExample.ts           # STDIO + progress notifications
    │   ├── toolWithSampleServer.ts      # STDIO + LLM sampling
    │   ├── mcpServerOutputSchema.ts     # STDIO + structured output
    │   ├── simpleStreamableHttp.ts      # Full HTTP server example
    │   └── ...
    ├── client/
    │   └── ...
    └── shared/
        └── inMemoryEventStore.ts
```

### Key STDIO Server Examples

| Example | File | Features |
|---------|------|----------|
| Progress | `progressExample.ts` | Progress notifications, abort handling |
| Sampling | `toolWithSampleServer.ts` | Bidirectional LLM sampling via `createMessage()` |
| Output Schema | `mcpServerOutputSchema.ts` | Structured output with `outputSchema` / `structuredContent` |
