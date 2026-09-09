#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# BioMCP Docker Deployment Smoke Test
# Validates: Docker build, Caddy reverse proxy, Streamable HTTP MCP handshake,
#            session persistence, tool dispatch, unbuffered streaming, and tracing.
# ==============================================================================

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${PROJECT_ROOT}"

if ! command -v docker >/dev/null 2>&1; then
  echo "SKIP: docker is not installed on this host."
  exit 0
fi

if ! docker info >/dev/null 2>&1; then
  echo "SKIP: docker daemon is not reachable or running."
  exit 0
fi

if [ -z "${BIOMCP_TEST_PORT:-}" ]; then
  TEST_PORT=$(node -e 'const s = require("node:net").createServer(); s.listen(0, () => { console.log(s.address().port); s.close(); });')
else
  TEST_PORT="${BIOMCP_TEST_PORT}"
fi

HTTPS_PORT=$(node -e 'const s = require("node:net").createServer(); s.listen(0, () => { console.log(s.address().port); s.close(); });')
AUTH_TOKEN="test-smoke-token-xyz"
COMPOSE_FILE="deploy/docker-compose.yml"
PROJECT_NAME="biomcp-smoke-$$"

cleanup() {
  echo "==> Cleaning up Docker containers and volumes..."
  docker compose -p "${PROJECT_NAME}" -f "${COMPOSE_FILE}" down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

echo "==> Building and starting BioMCP + Caddy stack on port ${TEST_PORT}..."

# Export test environment variables
export BIOMCP_DOMAIN=":80"
export BIOMCP_AUTH_TOKENS="${AUTH_TOKEN}:smoke-tester"
export CADDY_HTTP_PORT="${TEST_PORT}"
export CADDY_HTTPS_PORT="${HTTPS_PORT}"

docker compose -p "${PROJECT_NAME}" -f "${COMPOSE_FILE}" up -d --build

BASE_URL="http://127.0.0.1:${TEST_PORT}"

echo "==> [1/8] Waiting for healthcheck probe on ${BASE_URL}/health..."
HEALTHY=0
for _ in $(seq 1 45); do
  if curl -sf "${BASE_URL}/health" | grep -q '"status":"ok"'; then
    HEALTHY=1
    echo "    Healthcheck probe PASSED."
    break
  fi
  sleep 1
done

if [ "${HEALTHY}" -eq 0 ]; then
  echo "ERROR: Healthcheck probe timed out after 45s."
  docker compose -p "${PROJECT_NAME}" -f "${COMPOSE_FILE}" logs
  exit 1
fi

echo "==> [2/8] Verifying Bearer Authentication guard on /mcp..."
UNAUTH_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${BASE_URL}/mcp" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}')

if [ "${UNAUTH_STATUS}" -ne 401 ]; then
  echo "ERROR: Expected HTTP 401 for unauthenticated request, got ${UNAUTH_STATUS}"
  exit 1
fi
echo "    Authentication guard PASSED."

echo "==> [3/8] Initializing Streamable HTTP MCP Session..."
INIT_HEADERS=$(mktemp)
INIT_BODY=$(curl -s -D "${INIT_HEADERS}" -X POST "${BASE_URL}/mcp" \
  -H "Authorization: Bearer ${AUTH_TOKEN}" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-11-25",
      "capabilities": {},
      "clientInfo": { "name": "smoke-tester", "version": "1.0" }
    }
  }')

SESSION_ID=$(grep -i '^mcp-session-id:' "${INIT_HEADERS}" | tr -d '\r' | awk '{print $2}')
rm -f "${INIT_HEADERS}"

if [ -z "${SESSION_ID}" ]; then
  echo "ERROR: Server did not return Mcp-Session-Id header. Init response:"
  echo "${INIT_BODY}"
  exit 1
fi
echo "    Session established: ${SESSION_ID}"

echo "==> [4/8] Executing deterministic tool call through Caddy..."
SMOKE_REQ_ID="smoke-req-$RANDOM"
TOOL_HEADERS=$(mktemp)
TOOL_RESP=$(curl -s --no-buffer -D "${TOOL_HEADERS}" -X POST "${BASE_URL}/mcp" \
  -H "Authorization: Bearer ${AUTH_TOKEN}" \
  -H "Mcp-Session-Id: ${SESSION_ID}" \
  -H "X-Request-Id: ${SMOKE_REQ_ID}" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream, application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": {
      "name": "biomcp_configure",
      "arguments": { "action": "status" }
    }
  }')

if ! grep -qi 'content-type:' "${TOOL_HEADERS}"; then
  echo "ERROR: Missing Content-Type in response headers:"
  cat "${TOOL_HEADERS}"
  rm -f "${TOOL_HEADERS}"
  exit 1
fi

if ! grep -qi "^x-request-id:.*${SMOKE_REQ_ID}" "${TOOL_HEADERS}"; then
  echo "ERROR: Server did not echo X-Request-Id header. Headers:"
  cat "${TOOL_HEADERS}"
  rm -f "${TOOL_HEADERS}"
  exit 1
fi
rm -f "${TOOL_HEADERS}"

if ! echo "${TOOL_RESP}" | grep -q 'running_now'; then
  echo "ERROR: Tool response unexpected. Payload:"
  echo "${TOOL_RESP}"
  exit 1
fi
echo "    Tool execution and Request ID echo PASSED."

echo "==> [5/8] Verifying SQLite trace database and correlation..."
TRACE_OK=0
TRACE_ERR_FILE=$(mktemp)
for _ in $(seq 1 10); do
  VERIFY_OUT=$(docker compose -p "${PROJECT_NAME}" -f "${COMPOSE_FILE}" exec -T biomcp \
    node --no-warnings -e "
      const { DatabaseSync } = require('node:sqlite');
      try {
        const db = new DatabaseSync('/data/traces/biomcp.db', { readOnly: true });
        db.exec('PRAGMA busy_timeout = 5000;');

        const httpCount = db.prepare('SELECT COUNT(*) as count FROM http_traces').get()?.count ?? 0;
        const toolCount = db.prepare('SELECT COUNT(*) as count FROM tool_traces').get()?.count ?? 0;
        if (httpCount < 1 || toolCount < 1) {
          process.exit(2); // Queue not flushed yet
        }

        const correlatedTool = db.prepare('SELECT tool FROM tool_traces WHERE request_id = ?').get('${SMOKE_REQ_ID}');
        if (!correlatedTool || correlatedTool.tool !== 'biomcp_configure') {
          process.exit(3); // Tool trace missing or unaligned
        }

        const correlatedHttp = db.prepare('SELECT method FROM http_traces WHERE request_id = ?').get('${SMOKE_REQ_ID}');
        if (!correlatedHttp) {
          process.exit(4); // HTTP trace missing
        }

        const start = parseInt(db.prepare(\"SELECT value FROM trace_meta WHERE key='period_start_epoch'\").get()?.value, 10);
        const end = parseInt(db.prepare(\"SELECT value FROM trace_meta WHERE key='period_end_epoch'\").get()?.value, 10);
        const diffDays = Math.round((end - start) / (1000 * 60 * 60 * 24));
        if (diffDays !== 7) {
          console.error('Invalid period days:', diffDays);
          process.exit(5);
        }

        db.close();
        process.stdout.write('OK:http=' + httpCount + ':tool=' + toolCount);
      } catch (err) {
        console.error(err);
        process.exit(1);
      }
    " 2>"${TRACE_ERR_FILE}") && {
      TRACE_OK=1
      echo "    SQLite trace verification PASSED (${VERIFY_OUT})."
      break
    }
  sleep 0.5
done

if [ "${TRACE_OK}" -ne 1 ]; then
  echo "ERROR: SQLite trace validation failed or timed out after 5s. Last diagnostics:"
  cat "${TRACE_ERR_FILE}"
  rm -f "${TRACE_ERR_FILE}"
  exit 1
fi
rm -f "${TRACE_ERR_FILE}"

echo "==> [6/8] Verifying in-container CLI diagnostics (daemon status)..."
CLI_STATUS_OUTPUT=$(docker compose -p "${PROJECT_NAME}" -f "${COMPOSE_FILE}" exec -T biomcp \
  env NODE_NO_WARNINGS=1 node dist/cli.js daemon status)

if ! echo "${CLI_STATUS_OUTPUT}" | grep -q 'Trace Database (/data/traces/biomcp.db)'; then
  echo "ERROR: CLI daemon status did not report trace database metrics:"
  echo "${CLI_STATUS_OUTPUT}"
  exit 1
fi
echo "    Local CLI diagnostics PASSED."

echo "==> [7/8] Verifying retired /admin/status returns HTTP 404..."
ADMIN_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${BASE_URL}/admin/status")
if [ "${ADMIN_STATUS}" -ne 404 ]; then
  echo "ERROR: Expected HTTP 404 for /admin/status, got ${ADMIN_STATUS}"
  exit 1
fi
echo "    Endpoint hygiene PASSED."

echo "==> [8/8] Terminating session (DELETE /mcp)..."
DEL_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "${BASE_URL}/mcp" \
  -H "Authorization: Bearer ${AUTH_TOKEN}" \
  -H "Mcp-Session-Id: ${SESSION_ID}")

if [ "${DEL_STATUS}" -ne 200 ] && [ "${DEL_STATUS}" -ne 204 ]; then
  echo "ERROR: DELETE /mcp failed with status ${DEL_STATUS}"
  exit 1
fi
echo "    Session teardown PASSED."

echo "==> All Docker deployment smoke tests completed successfully."
