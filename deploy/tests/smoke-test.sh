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
trap cleanup EXIT ERR INT TERM

echo "==> Building and starting BioMCP + Caddy stack on port ${TEST_PORT}..."

# Export test environment variables
export BIOMCP_DOMAIN=":80"
export BIOMCP_AUTH_TOKENS="${AUTH_TOKEN}:smoke-tester"
export CADDY_HTTP_PORT="${TEST_PORT}"
export CADDY_HTTPS_PORT="${HTTPS_PORT}"

docker compose -p "${PROJECT_NAME}" -f "${COMPOSE_FILE}" up -d --build

BASE_URL="http://127.0.0.1:${TEST_PORT}"

echo "==> [1/6] Waiting for healthcheck probe on ${BASE_URL}/health..."
HEALTHY=0
for i in $(seq 1 45); do
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

echo "==> [2/6] Verifying Bearer Authentication guard on /mcp..."
UNAUTH_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${BASE_URL}/mcp" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}')

if [ "${UNAUTH_STATUS}" -ne 401 ]; then
  echo "ERROR: Expected HTTP 401 for unauthenticated request, got ${UNAUTH_STATUS}"
  exit 1
fi
echo "    Authentication guard PASSED."

echo "==> [3/6] Initializing Streamable HTTP MCP Session..."
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

echo "==> [4/6] Executing deterministic tool call through Caddy..."
TOOL_HEADERS=$(mktemp)
TOOL_RESP=$(curl -s --no-buffer -D "${TOOL_HEADERS}" -X POST "${BASE_URL}/mcp" \
  -H "Authorization: Bearer ${AUTH_TOKEN}" \
  -H "Mcp-Session-Id: ${SESSION_ID}" \
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
rm -f "${TOOL_HEADERS}"

if ! echo "${TOOL_RESP}" | grep -q 'running_now'; then
  echo "ERROR: Tool response unexpected. Payload:"
  echo "${TOOL_RESP}"
  exit 1
fi
echo "    Tool execution PASSED."

echo "==> [5/6] Verifying trace persistence in Docker volume..."
sleep 1
docker compose -p "${PROJECT_NAME}" -f "${COMPOSE_FILE}" exec -T biomcp \
  test -s /data/traces/biomcp.jsonl || {
    echo "ERROR: Trace file /data/traces/biomcp.jsonl is missing or empty."
    exit 1
  }
echo "    Trace logging PASSED."

echo "==> [6/6] Terminating session (DELETE /mcp)..."
DEL_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "${BASE_URL}/mcp" \
  -H "Authorization: Bearer ${AUTH_TOKEN}" \
  -H "Mcp-Session-Id: ${SESSION_ID}")

if [ "${DEL_STATUS}" -ne 200 ] && [ "${DEL_STATUS}" -ne 204 ]; then
  echo "ERROR: DELETE /mcp failed with status ${DEL_STATUS}"
  exit 1
fi
echo "    Session teardown PASSED."

echo "==> All Docker deployment smoke tests completed successfully."
