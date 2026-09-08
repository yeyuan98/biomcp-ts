export interface SystemdOptions {
  user?: string;
  port?: number;
  host?: string;
  workdir?: string;
  nodePath?: string;
  biomcpPath?: string;
}

export function generateSystemdService(options?: SystemdOptions): string {
  const user = options?.user ?? 'biomcp';
  const port = options?.port ?? 3000;
  const host = options?.host ?? '127.0.0.1';
  const workdir = options?.workdir ?? '/opt/biomcp';
  const nodePath = options?.nodePath ?? '/usr/bin/node';
  const biomcpPath = options?.biomcpPath ?? `${workdir}/dist/cli.js`;

  return `[Unit]
Description=BioMCP Streamable HTTP MCP Server
After=network.target

[Service]
Type=simple
User=${user}
Group=${user}
WorkingDirectory=${workdir}
EnvironmentFile=-/etc/biomcp/biomcp.env
ExecStart=${nodePath} ${biomcpPath} serve --host ${host} --port ${port}
Restart=always
RestartSec=5s

# Security Hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
PrivateTmp=true
ReadWritePaths=/var/log/biomcp /var/cache/biomcp

[Install]
WantedBy=multi-user.target
`;
}
