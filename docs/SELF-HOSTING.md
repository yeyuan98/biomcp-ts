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

To audit usage and inspect tool executions without leaking sensitive payloads, BioMCP records structured traces in an embedded SQLite database (`node:sqlite`) with WAL mode and micro-batch transactions:

```bash
biomcp serve --trace --trace-file /var/log/biomcp/traces.db --trace-period-days 7
```

Or via environment variables:

```bash
export BIOMCP_TRACE=true
export BIOMCP_TRACE_FILE=/var/log/biomcp/traces.db
export BIOMCP_TRACE_PERIOD_DAYS=7
```

### Database Architecture & Rotation

- **Active Database**: Always written to `--trace-file` (default: `./biomcp-traces.db`).
- **Periodic Rotation**: Every X days (configured by `--trace-period-days`, default 7), the active database is checkpointed, closed, and rotated to:
  ```
  biomcp-traces-archive_<START_UTC>_<END_UTC>.db
  ```
- **Inspecting Status**: Admins can inspect trace metrics and archives locally via CLI on the server machine:
  ```bash
  biomcp daemon status
  ```
  Or query directly using standard SQLite tools:
  ```bash
  sqlite3 /var/log/biomcp/traces.db "SELECT tool, COUNT(*), AVG(duration_ms) FROM tool_traces GROUP BY tool;"
  ```

### Trace Record Tables

- **`http_traces`**: Captures `request_id`, `timestamp`, `epoch_ms`, `method`, `path`, `status`, `duration_ms`, `client_label`, `client_ip`, and `session_id`.
- **`tool_traces`**: Captures `request_id`, `timestamp`, `epoch_ms`, `tool`, `session_id`, `client_label`, `duration_ms`, `status`, `input_args` (sanitized JSON), and `error`.

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

## Health & Status Inspection

- `GET /health`: Minimal unauthenticated probe returning `{"status":"ok"}` with HTTP 200 (ideal for Docker, Kubernetes, and load balancers).
- Local CLI Status: Run `biomcp daemon status` directly on the server host to inspect daemon process health, uptime, active session count, memory usage, and SQLite trace database metrics. The HTTP API is strictly reserved for end-user MCP traffic (`/mcp`) and infrastructure health probes (`/health`).
