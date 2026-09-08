export interface CaddyfileOptions {
  domain?: string;
  port?: number;
  upstream?: string;
}

export function generateCaddyfile(options?: CaddyfileOptions): string {
  const domain = options?.domain ?? 'mcp.example.com';
  const port = options?.port ?? 3000;
  const upstream = options?.upstream ? options.upstream : '{$BIOMCP_UPSTREAM:127.0.0.1}';

  return `# Caddyfile for biomcp Streamable HTTP MCP Server
# https://caddyserver.com/docs/caddyfile

${domain} {
    # Reverse proxy to biomcp Node runtime
    # flush_interval -1 is critical for real-time SSE streaming without buffering
    reverse_proxy ${upstream}:${port} {
        flush_interval -1
        header_up X-Forwarded-Proto {scheme}
        header_up X-Forwarded-Host {host}
    }

    # Enable compression for regular JSON responses
    encode gzip zstd

    # Structured access logging
    log {
        output stdout
        format console
    }
}
`;
}
