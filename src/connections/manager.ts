import { IConnection, ConnectionOptions, ProtocolType } from './base.js';
import { RestConnection } from './rest.js';
import { GraphQLConnection } from './graphql.js';
import { GrpcConnection } from './grpc.js';
import { getSourceConfig } from './registry.js';
// Side-effect import: proxy-aware global fetch (no-op without proxy env).
import './proxy.js';

export class ConnectionManager {
  private connections = new Map<string, IConnection<any, any>>();
  
  getConnection(sourceId: string): IConnection<any, any> {
    if (this.connections.has(sourceId)) {
      return this.connections.get(sourceId)!;
    }
    
    const config = getSourceConfig(sourceId);
    const connection = this.createConnection(config);
    
    this.connections.set(sourceId, connection);
    return connection;
  }
  
  createConnection(config: ConnectionOptions): IConnection<any, any> {
    switch (config.protocol) {
      case 'rest':
        return new RestConnection(config);
      
      case 'graphql':
        return new GraphQLConnection(config, config.auth);
      
      case 'grpc':
        return new GrpcConnection(config);
      
      case 'local-file':
        throw new Error('Local file connection not yet implemented');
      
      default:
        throw new Error(`Unsupported protocol: ${config.protocol}`);
    }
  }
  
  async healthCheckAll(): Promise<Record<string, boolean>> {
    const results: Record<string, boolean> = {};
    
    const checks = Array.from(this.connections.entries()).map(
      async ([id, conn]) => {
        results[id] = await conn.healthCheck();
      }
    );
    
    await Promise.allSettled(checks);
    return results;
  }
  
  closeAll(): void {
    for (const conn of this.connections.values()) {
      conn.close();
    }
    this.connections.clear();
  }
  
  listConnections(): string[] {
    return Array.from(this.connections.keys());
  }
}

export const connectionManager = new ConnectionManager();