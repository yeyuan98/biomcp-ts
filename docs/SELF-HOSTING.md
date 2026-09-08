# Self-Hosting BioMCP (Streamable HTTP & Caddy)

BioMCP can be self-hosted as a remote, multi-tenant MCP server over HTTPS using the modern **Streamable HTTP** transport (MCP specification `2025-11-25`).

This allows operators to centrally configure upstream biomedical API keys (NCBI, Semantic Scholar, OpenFDA, OncoKB, DisGeNET, CrossRef, EPO, USPTO, and local database backends) and share a fast, authenticated endpoint with team members or agent harnesses without requiring individual API key setups.

---

## Quick Start

### 1. Foreground Run (`biomcp serve`)

To run the remote server directly in the foreground:

```bash
# Run on localhost:3000 with a specific Bearer token
biomcp serve --host 127.0.0.1 --port 3000 --token "my-secret-token"

# Or configure via environment variables
export BIOMCP_AUTH_TOKENS="tok_team_alpha:alice,tok_team_beta:bob"
export BIOMCP_PORT=3000
export NCBI_API_KEY="your-ncbi-key"
export S2_API_KEY="your-s2-key"

biomcp serve
```

### 2. Background Daemon (`biomcp daemon`)

BioMCP includes built-in state-file daemon management:

```bash
# Start background daemon
biomcp daemon start --port 3000 --token "my-secret-token" --trace

# Check health and status
biomcp daemon status

# Restart daemon
biomcp daemon restart

# Gracefully stop daemon
biomcp daemon stop
```

---

## HTTPS & Reverse Proxy with Caddy

For production deployments on public networks, place BioMCP behind Caddy. Caddy handles automatic TLS (Let's Encrypt / ZeroSSL), HTTP/2, and HTTP/3.

### Caddyfile Template

Generate a production Caddyfile:

```bash
biomcp remote caddyfile --domain mcp.example.com --port 3000 > Caddyfile
```

Content:

```caddyfile
mcp.example.com {
    # flush_interval -1 disables buffering for real-time SSE streaming delivery
    reverse_proxy 127.0.0.1:3000 {
        flush_interval -1
        header_up X-Forwarded-Proto {scheme}
        header_up X-Forwarded-Host {host}
    }

    encode gzip zstd
}
```

> **Important**: The `flush_interval -1` directive is essential. It disables reverse proxy response buffering, ensuring SSE events and streaming tool results flush immediately to clients.

---

## Docker Compose Deployment

Run BioMCP + Caddy in isolated containers with automatic TLS:

```bash
cd deploy
# Copy and edit environment variables
cp .env.example .env

# Start containers
docker compose up -d
```

### Automated Deployment Verification

Run the end-to-end deployment smoke test to verify Docker build, Caddy reverse proxy routing, Bearer authentication, tool execution, unbuffered streaming, and trace logging:

```bash
npm run test:deploy
# or
bash deploy/tests/smoke-test.sh
```

---

## Authentication & Authorization

All requests to the remote `/mcp` endpoint must include the Bearer token in the `Authorization` header:

```http
Authorization: Bearer <your-token>
```

### Multi-Token Support

Set `BIOMCP_AUTH_TOKENS` to a comma-separated list of tokens or `token:label` pairs:

```bash
export BIOMCP_AUTH_TOKENS="sec_123:lab-team,sec_456:analyst-bob,sec_789:agent-runner"
```

- Incoming tokens are validated in constant time using SHA-256 pre-hashing and `crypto.timingSafeEqual`.
- Client labels (`lab-team`, `analyst-bob`) are attached to tool execution logs.

---

## Tool & Traffic Trace Recording

To audit usage and inspect tool executions without leaking sensitive payloads:

```bash
biomcp serve --trace --trace-file /var/log/biomcp/traces.jsonl
```

Or via environment variables:

```bash
export BIOMCP_TRACE=true
export BIOMCP_TRACE_FILE=/var/log/biomcp/traces.jsonl
```

### Trace Record Format (JSON Lines)

**HTTP Traffic Record**:
```json
{
  "type": "http_request",
  "timestamp": "2026-09-08T12:00:00.000Z",
  "method": "POST",
  "path": "/mcp",
  "status": 200,
  "durationMs": 128,
  "clientLabel": "lab-team",
  "clientIp": "192.168.1.50",
  "sessionId": "4a2b3c4d-..."
}
```

**Tool Call Record**:
```json
{
  "type": "tool_call",
  "timestamp": "2026-09-08T12:00:00.050Z",
  "tool": "gene_search",
  "sessionId": "4a2b3c4d-...",
  "clientLabel": "lab-team",
  "durationMs": 85,
  "status": "success",
  "inputArgs": {
    "query": "BRAF",
    "limit": 5
  }
}
```

*Large parameters (>512 characters) are automatically truncated, and sensitive keys (passwords, tokens, API keys) are redacted.*

---

## Client Configuration

To connect any MCP client (Claude Desktop, OpenCode, Cursor, custom agents) to your self-hosted instance:

```json
{
  "mcpServers": {
    "biomcp": {
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer my-secret-token"
      }
    }
  }
}
```

---

## Health & Diagnostics Endpoints

- `GET /health`: Minimal unauthenticated probe returning `{"status":"ok"}` with HTTP 200 (ideal for Docker, Kubernetes, and load balancers).
- `GET /admin/status`: Authenticated diagnostics returning server version, uptime, active session count, memory usage, and biowasm artifact count.
