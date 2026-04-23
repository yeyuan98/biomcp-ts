import { 
  IConnection, 
  ConnectionOptions, 
  AuthConfig, 
  ProtocolType 
} from './base.js';

interface GrpcRequest {
  variant: string;
  scorer?: string;
}

export class GrpcConnection implements IConnection<GrpcRequest, unknown> {
  readonly sourceId: string;
  readonly protocol: ProtocolType = 'grpc';
  effectiveRateLimitMs: number = 0;
  
  private readonly auth?: AuthConfig;
  private readonly apiKey: string | undefined;
  
  constructor(private readonly options: ConnectionOptions) {
    this.sourceId = options.sourceId;
    this.auth = options.auth;
    this.apiKey = process.env[options.auth?.envVar || ''];
  }
  
  async request(req: GrpcRequest): Promise<unknown> {
    if (!req.scorer) {
      req.scorer = 'GeneMaskLFCScorer';
    }
    
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    
    if (this.apiKey && this.options.auth?.delivery.type === 'grpc-metadata') {
      headers['x-goog-api-key'] = this.apiKey;
    }
    
    const [host, port] = this.options.baseUrl.split(':');
    
    try {
      const response = await fetch(`https://${host}/v1/scoreVariant:scoreVariant`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          reference_variant: req.variant,
          scorers: [req.scorer],
        }),
      });
      
      if (!response.ok) {
        throw new Error(`gRPC HTTP proxy error: ${response.status}`);
      }
      
      return response.json();
    } catch (error) {
      if (error instanceof Error && error.message.includes('fetch')) {
        throw new Error('AlphaGenome gRPC not available. Set ALPHAGENOME_API_KEY for access.');
      }
      throw error;
    }
  }
  
  async batch(requests: GrpcRequest[]): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const req of requests) {
      results.push(await this.request(req));
    }
    return results;
  }
  
  async healthCheck(): Promise<boolean> {
    if (!this.apiKey) {
      return false;
    }
    
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'x-goog-api-key': this.apiKey,
      };
      
      const response = await fetch(`https://gdmscience.googleapis.com/v1/health`, {
        method: 'GET',
        headers,
      });
      
      return response.ok || response.status === 404;
    } catch {
      return false;
    }
  }
  
  close(): void {
    // No persistent connections
  }
}