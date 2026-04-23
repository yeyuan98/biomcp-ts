# BioMCP TypeScript Rewrite — Implementation Plan v1

> Version: 1.0 | Date: 2026-04-22 | Status: Planning

---

## 1. Project Overview

### 1.1 Goal

Rewrite BioMCP (a biomedical MCP server) from Rust to TypeScript using the MCP SDK 1.x, providing easy-to-use MCP tools for agents while maintaining comprehensive coverage of 54 external biomedical data sources.

### 1.2 Requirements

1. **No CLI** — Focus on MCP tools only
2. **Comprehensive external DB/API coverage** — Abstract connections by type with rate limiting and optional auth
3. **Agent-friendly MCP tools** — Natural, discoverable tools

---

## 2. Architecture

### 2.1 Three-Layer Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ MCP Server Layer (@modelcontextprotocol/sdk)                │
│ - Tools, Resources, Prompts                                │
├─────────────────────────────────────────────────────────────┤
│ Entity Orchestration Layer                                │
│ - Search, Get, Cross-entity pivots                        │
│ - Section-based enrichment with timeout/degradation        │
├─────────────────────────────────────────────────────────────┤
│ Connection Abstraction Layer                              │
│ - Factory pattern for REST/GraphQL/gRPC/local-file         │
│ - Token bucket rate limiting                             │
│ - Auth abstraction (required/optional keys)                │
├─────────────────────────────────────────────────────────────┤
│ Source Registry (54 pre-configured sources)               │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 Project Structure

```
biomcp-ts/
├── src/
│   ├── server/
│   │   ├── index.ts           # Main entry point
│   │   ├── tools/             # MCP tool definitions
│   │   │   ├── gene/
│   │   │   ├── variant/
│   │   │   ├── drug/
│   │   │   └── ...
│   │   └── prompts/           # MCP prompts
│   │
│   ├── entities/              # Entity orchestration
│   │   ├── gene.ts
│   │   ├── variant.ts
│   │   ├── drug.ts
│   │   └── ...
│   │
│   ├── connections/          # Connection abstraction
│   │   ├── base.ts           # Interfaces
│   │   ├── factory.ts        # Factory pattern
│   │   ├── rest.ts           # REST implementation
│   │   ├── graphql.ts        # GraphQL implementation
│   │   ├── grpc.ts           # gRPC implementation
│   │   ├── local-file.ts     # Local file with cache
│   │   ├── rate-limiter.ts   # Token bucket
│   │   ├── registry.ts       # 54 source configs
│   │   └── manager.ts        # Connection lifecycle
│   │
│   ├── transform/            # API response → domain
│   │   ├── gene.ts
│   │   ├── variant.ts
│   │   └── ...
│   │
│   ├── cache/                # HTTP + file caching
│   │
│   └── types/                # Shared TypeScript types
│
├── package.json
├── tsconfig.json
└── IMPLEMENTATION-PLAN-v1.md
```

---

## 3. Connection Abstraction Layer

### 3.1 Protocol Support

| Protocol | Count | Sources |
|----------|-------|---------|
| REST | 46 | MyGene, PubMed, UniProt, etc. |
| GraphQL | 5 | gnomAD, CIViC, DGIdb, Open Targets |
| gRPC | 1 | AlphaGenome (streaming) |
| Local File | 7 | EMA, WHO PQ, WHO IVD, GTR, CVX |

### 3.2 Core Interfaces

```typescript
// src/connections/base.ts

export type ProtocolType = 'rest' | 'graphql' | 'grpc' | 'local-file';

export type AuthDeliveryMethod =
  | { type: 'header'; name: string }
  | { type: 'bearer' }
  | { type: 'query-param'; name: string }
  | { type: 'grpc-metadata'; name: string };

export interface AuthConfig {
  envVar: string;
  required: boolean;
  delivery: AuthDeliveryMethod;
  fallbackRateLimitMs?: number;
  keyedRateLimitMs?: number;
}

export interface RateLimitConfig {
  intervalMs: number;
  conditional?: boolean;
}

export interface ConnectionOptions {
  sourceId: string;
  baseUrl: string;
  protocol: ProtocolType;
  auth?: AuthConfig;
  rateLimit: RateLimitConfig;
  handling?: ConnectionHandling;
}

export interface IConnection<TRequest, TResponse> {
  readonly sourceId: string;
  readonly protocol: ProtocolType;
  readonly hasAuth: boolean;
  readonly effectiveRateLimitMs: number;
  
  request(req: TRequest): Promise<TResponse>;
  batch(requests: TRequest[]): Promise<TResponse[]>;
  healthCheck(): Promise<boolean>;
  close(): void;
}
```

### 3.3 Rate Limiting

- **Token bucket algorithm** with smooth backpressure
- **Dual-rate pattern**: Faster with API key, slower without
  - PubMed: 100ms (key) / 334ms (no key)
  - Semantic Scholar: 1000ms (key) / 2000ms (no key)

### 3.4 Auth Requirements

| Required Keys | Optional Keys |
|--------------|---------------|
| ALPHAGENOME_API_KEY | NCBI_API_KEY |
| DISGENET_API_KEY | S2_API_KEY |
| UMLS_API_KEY | OPENFDA_API_KEY |
| | NCI_API_KEY |
| | ONCOKB_TOKEN |

---

## 4. MCP Tool Interface Design

### 4.1 Tool Taxonomy (~41 tools)

#### Search Tools (13)

| Tool | Description |
|------|-------------|
| `gene_search` | Search genes by symbol, name, keyword |
| `variant_search` | Search variants with 22 filters |
| `drug_search` | Search drugs by name, mechanism |
| `disease_search` | Search diseases by name, phenotype |
| `article_search` | Search literature (5 backends) |
| `trial_search` | Search clinical trials (19 filters) |
| `pathway_search` | Search pathways (Reactome/KEGG/Wiki) |
| `protein_search` | Search proteins by accession |
| `pgx_search` | Search pharmacogenomics |
| `gwas_search` | Search GWAS associations |
| `phenotype_search` | Search HPO phenotypes |
| `diagnostic_search` | Search diagnostics (GTR/WHO) |
| `adverse_event_search` | Search adverse events |

#### Get Tools (11)

| Tool | Sections |
|------|----------|
| `gene_get` | 15 optional sections |
| `variant_get` | Core, frequency, predictions, clinical |
| `drug_get` | Core, US, EU, WHO regulatory |
| `disease_get` | 13 sections |
| `article_get` | Core, OA, annotations, graph |
| `trial_get` | Core, eligibility, locations, outcomes |
| `pathway_get` | Genes, events, enrichment |
| `protein_get` | Domains, interactions, complexes |
| `pgx_get` | Recommendations, frequencies, guidelines |
| `diagnostic_get` | Test details |
| `batch_get` | Multiple entities parallel |

#### Cross-Entity Pivots (12)

| Tool | From → To |
|------|-----------|
| `gene_drugs` | Gene → Drug |
| `gene_trials` | Gene → Trial |
| `gene_pathways` | Gene → Pathway |
| `gene_articles` | Gene → Article |
| `variant_trials` | Variant → Trial |
| `drug_genes` | Drug → Gene |
| `drug_trials` | Drug → Trial |
| `drug_adverse_events` | Drug → Adverse Event |
| `disease_drugs` | Disease → Drug |
| `disease_genes` | Disease → Gene |
| `disease_trials` | Disease → Trial |
| `gene_enrich` | Gene list → pathway enrichment |

#### Utility Tools (3)

| Tool | Description |
|------|-------------|
| `discover` | Free-text concept resolution |
| `search_all` | Federated cross-entity search |
| `biomcp_health` | Check upstream API health |

#### Metadata Tools (2)

| Tool | Description |
|------|-------------|
| `biomcp_list` | List available entities/commands |
| `version` | Server version |

### 4.2 Example Tool Definition

```typescript
// src/server/tools/gene.ts

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export function registerGeneTools(server: McpServer): void {
  server.registerTool(
    'gene_search',
    {
      description: 'Search for genes by symbol, name, or keyword',
      inputSchema: {
        query: z.string().describe('Gene symbol, name, or keyword to search for'),
        gene_type: z.enum(['protein-coding', 'ncRNA', 'pseudo']).optional(),
        chromosome: z.string().optional(),
        limit: z.number().int().min(1).max(50).default(10),
        offset: z.number().int().min(0).default(0),
      }
    },
    async ({ query, gene_type, chromosome, limit, offset }) => {
      const results = await geneSearch(query, { gene_type, chromosome, limit, offset });
      return { content: [{ type: 'text', text: JSON.stringify(results) }] };
    }
  );

  server.registerTool(
    'gene_get',
    {
      description: 'Get detailed gene information by symbol',
      inputSchema: {
        symbol: z.string().describe('HGNC gene symbol (e.g., "BRAF", "TP53")'),
        sections: z.array(z.enum([
          'pathways', 'ontology', 'diseases', 'diagnostics', 'protein',
          'go', 'interactions', 'civic', 'expression', 'hpa', 'druggability',
          'clingen', 'constraint', 'disgenet', 'funding', 'all'
        ])).optional().describe('Sections to include'),
      }
    },
    async ({ symbol, sections }) => {
      const result = await geneGet(symbol, sections);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );
}
```

---

## 5. Entity Orchestration

### 5.1 Section-Based Enrichment

```typescript
// src/entities/gene.ts

export class GeneOrchestrator {
  async get(symbol: string, sections?: string[]): Promise<GeneResult> {
    const sectionConfig = sections || ['core'];
    
    const results = await Promise.allSettled(
      sectionConfig.map(section => this.fetchSection(symbol, section, 8000))
    );
    
    return this.aggregateResults(results);
  }
  
  private async fetchSection(
    symbol: string, 
    section: string, 
    timeoutMs: number
  ): Promise<SectionResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    
    try {
      return await this.fetchFromSource(symbol, section, controller.signal);
    } catch (e) {
      if (e.name === 'AbortError') {
        return { section, status: 'timeout', note: `${section} timed out` };
      }
      throw e;
    } finally {
      clearTimeout(timeout);
    }
  }
  
  private async fetchFromSource(
    symbol: string, 
    section: string, 
    signal: AbortSignal
  ): Promise<SectionResult> {
    switch (section) {
      case 'pathways':
        return this.fetchPathways(symbol, signal);
      case 'protein':
        return this.fetchProtein(symbol, signal);
      // ... other sections
      default:
        return this.fetchCore(symbol, signal);
    }
  }
}
```

### 5.2 Federated Search (Articles)

```typescript
// src/entities/article.ts

export class ArticleOrchestrator {
  async search(query: string, limit: number = 10): Promise<ArticleResult[]> {
    const backends = [
      this.pubtator.search(query),
      this.europePmc.search(query),
      this.pubmed.search(query),
      this.semanticScholar.search(query),
      this.litSense.search(query),
    ];
    
    const results = await Promise.allSettled(backends);
    const deduped = this.deduplicate(results);
    return this.rank(deduped, limit);
  }
  
  private deduplicate(results: PromiseSettledResult<ArticleResult[]>[]): ArticleResult[] {
    const seen = new Map<string, ArticleResult>();
    
    for (const result of results) {
      if (result.status === 'fulfilled') {
        for (const article of result.value) {
          const key = article.pmid || article.pmcid || article.doi;
          if (key && !seen.has(key)) {
            seen.set(key, article);
          }
        }
      }
    }
    
    return Array.from(seen.values());
  }
  
  private rank(articles: ArticleResult[], limit: number): ArticleResult[] {
    // Composite ranking: 0.4*semantic + 0.3*lexical + 0.2*citations + 0.1*position
    return articles
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, limit);
  }
}
```

---

## 6. Implementation Phases

### Phase 1: Foundation (Week 1-2)

- [ ] 1.1 Initialize TypeScript project with MCP SDK 1.x
- [ ] 1.2 Set up MCP server with stdio transport
- [ ] 1.3 Implement connection base interfaces
- [ ] 1.4 Implement rate limiter (token bucket)
- [ ] 1.5 Implement REST connection
- [ ] 1.6 Implement GraphQL connection
- [ ] 1.7 Implement gRPC connection (stub for AlphaGenome)
- [ ] 1.8 Implement local file connection
- [ ] 1.9 Create source registry with all 54 sources

### Phase 2: Core Gene Entity (Week 3)

- [ ] 2.1 Implement MyGene.info connection
- [ ] 2.2 Implement gene search
- [ ] 2.3 Implement gene core get
- [ ] 2.4 Add pathways section (Reactome)
- [ ] 2.5 Add protein section (UniProt)
- [ ] 2.6 Add interactions section (STRING)
- [ ] 2.7 Add constraint section (gnomAD)
- [ ] 2.8 Add remaining sections
- [ ] 2.9 Register gene tools in MCP server

### Phase 3: Variant Entity (Week 4)

- [ ] 3.1 Implement MyVariant.info connection
- [ ] 3.2 Implement variant search
- [ ] 3.3 Implement variant get with sections
- [ ] 3.4 Add OncoKB annotations
- [ ] 3.5 Add AlphaGenome scoring (gRPC)
- [ ] 3.6 Register variant tools

### Phase 4: Additional Entities (Week 5-6)

- [ ] 4.1 Drug entity (MyChem, ChEMBL, OpenFDA)
- [ ] 4.2 Disease entity (MyDisease, Monarch, OpenTargets)
- [ ] 4.3 Article entity (5-backend federated search)
- [ ] 4.4 Trial entity (ClinicalTrials.gov, NCI CTS)
- [ ] 4.5 Pathway entity (Reactome, KEGG, WikiPathways)
- [ ] 4.6 Protein entity
- [ ] 4.7 PGx entity (CPIC, PharmGKB)

### Phase 5: Cross-Entity & Polish (Week 7-8)

- [ ] 5.1 Cross-entity pivot tools
- [ ] 5.2 Discover tool (OLS4)
- [ ] 5.3 Search all (federated)
- [ ] 5.4 Batch get
- [ ] 5.5 Health check tool
- [ ] 5.6 Error handling improvements
- [ ] 5.7 Output validation
- [ ] 5.8 Testing

---

## 7. Source Registry Reference

### 7.1 REST Sources

```typescript
// src/connections/registry.ts

export const SOURCE_REGISTRY: Record<string, ConnectionOptions> = {
  // Genomics
  mygene: {
    sourceId: 'mygene',
    baseUrl: 'https://mygene.info/v3',
    protocol: 'rest',
    rateLimit: { intervalMs: 100 },
  },
  myvariant: {
    sourceId: 'myvariant',
    baseUrl: 'https://myvariant.info/v1',
    protocol: 'rest',
    rateLimit: { intervalMs: 100 },
  },
  clingen: {
    sourceId: 'clingen',
    baseUrl: 'https://search.clinicalgenome.org',
    protocol: 'rest',
    rateLimit: { intervalMs: 100 },
  },
  // ... all 46 REST sources
};
```

### 7.2 GraphQL Sources

```typescript
export const SOURCE_REGISTRY: Record<string, ConnectionOptions> = {
  gnomad: {
    sourceId: 'gnomad',
    baseUrl: 'https://gnomad.broadinstitute.org/api',
    protocol: 'graphql',
    rateLimit: { intervalMs: 100 },
  },
  civic: {
    sourceId: 'civic',
    baseUrl: 'https://civicdb.org/api',
    protocol: 'graphql',
    rateLimit: { intervalMs: 334 },
  },
  // ... all 5 GraphQL sources
};
```

### 7.3 Sources with Optional Auth

```typescript
pubmed: {
  sourceId: 'pubmed',
  baseUrl: 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils',
  protocol: 'rest',
  auth: {
    envVar: 'NCBI_API_KEY',
    required: false,
    delivery: { type: 'query-param', name: 'api_key' },
  },
  rateLimit: {
    intervalMs: 100,
    conditional: true,
    fallbackRateLimitMs: 334,
    keyedRateLimitMs: 100,
  },
},
```

---

## 8. Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| No CLI | Requirement - focus on MCP tools only |
| Per-entity tools | Better discoverability than single biomcp tool |
| Token bucket rate limiting | Smooth backpressure vs. simple delays |
| Dual-rate for optional keys | Works without keys, faster with keys |
| Promise.allSettled | Graceful degradation on timeout |
| Zod for schemas | Native MCP SDK 1.x support |

---

## 9. Out of Scope

- CLI interface (explicitly excluded per requirements)
- Write/mutating operations (read-only BioMCP)
- Local file download caching (simplified)
- Skill/guide system (can be added later via MCP prompts)
- Self-update mechanism

---

## 10. Dependencies

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0",
    "zod": "^3.25.0"
  },
  "devDependencies": {
    "typescript": "^5.0.0",
    "@types/node": "^20.0.0"
  }
}
```
