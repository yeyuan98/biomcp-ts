# BioMCP

Biomedical Model Context Protocol (MCP) Server - A TypeScript implementation providing MCP tools for biomedical data access.

## Features

- **Comprehensive biomedical data coverage** from 50+ data sources
- **Cross-entity navigation** - Navigate between related biomedical entities
- **Federated search** - Search across multiple sources simultaneously
- **Section-based enrichment** - Fetch detailed information with graceful degradation

## Quick Start

### Installation

```bash
npm install
npm run build
```

### Running the Server

```bash
# Development mode
npm run dev

# Production
npm start
```

The server uses stdio transport for MCP communication.

### Using with Claude Desktop

Add to your Claude Desktop config:

```json
{
  "mcpServers": {
    "biomcp": {
      "command": "node",
      "args": ["/path/to/biomcp-ts/dist/server/index.js"]
    }
  }
}
```

## Available Tools

### Gene Tools

| Tool | Description |
|------|-------------|
| `gene_search` | Search genes by symbol, name, or keyword |
| `gene_get` | Get detailed gene information with sections |
| `gene_drugs` | Find drugs targeting a gene |
| `gene_trials` | Find clinical trials for a gene |
| `gene_pathways` | Find pathways containing a gene |
| `gene_articles` | Find articles about a gene |

### Variant Tools

| Tool | Description |
|------|-------------|
| `variant_search` | Search variants |
| `variant_get` | Get variant details |
| `variant_trials` | Find trials for variant |

### Drug Tools

| Tool | Description |
|------|-------------|
| `drug_search` | Search drugs |
| `drug_get` | Get drug details |
| `drug_genes` | Find genes targeted by drug |
| `drug_trials` | Find trials for drug |
| `drug_adverse_events` | Find adverse events |

### Disease Tools

| Tool | Description |
|------|-------------|
| `disease_search` | Search diseases |
| `disease_get` | Get disease details |
| `disease_drugs` | Find drugs for disease |
| `disease_genes` | Find genes for disease |
| `disease_trials` | Find trials for disease |

### Article Tools

| Tool | Description |
|------|-------------|
| `article_search` | Search literature (5 backends) |
| `article_get` | Get article details |

### Trial Tools

| Tool | Description |
|------|-------------|
| `trial_search` | Search clinical trials |
| `trial_get` | Get trial details |

### Utility Tools

| Tool | Description |
|------|-------------|
| `discover` | Free-text concept resolution |
| `search_all` | Federated cross-entity search |
| `batch_get` | Get multiple entities in parallel |
| `biomcp_health` | Check API connectivity |
| `biomcp_list` | List available tools |
| `version` | Get server version |

## Development

### Project Structure

```
src/
├── server/
│   ├── index.ts          # Entry point
│   ├── tools/           # MCP tool definitions
│   ├── errors.ts       # Error handling
│   └── validation.ts   # Input validation
├── entities/           # Entity orchestrators
│   ├── gene.ts
│   ├── variant.ts
│   ├── drug.ts
│   ├── disease.ts
│   ├── article.ts
│   ├── trial.ts
│   └── cross-entity.ts # Cross-entity pivots
├── connections/        # Connection abstraction
└── transform/         # Response transforms
```

### Running Tests

```bash
npm test
```

### Building

```bash
npm run build
npm run typecheck
```

## API Reference

### Tool Input Schemas

#### gene_search

```typescript
{
  query: string,           // Gene symbol, name, or keyword
  gene_type?: string,      // "protein-coding" | "ncRNA" | "pseudo"
  chromosome?: string,    // Filter chromosome (e.g., "7", "X")
  limit?: number,         // Default: 10, Max: 50
  offset?: number        // Default: 0
}
```

#### gene_get

```typescript
{
  symbol: string,                    // HGNC gene symbol
  sections?: string[]                // Optional sections to fetch
}
```

Available sections: `pathways`, `ontology`, `diseases`, `protein`, `go`, `interactions`, `civic`, `expression`, `hpa`, `druggability`, `clingen`, `constraint`, `disgenet`, `funding`, `all`

#### discover

```typescript
{
  query: string  // Free-text query
}
```

Returns entity matches across all types (gene, variant, drug, disease).

#### search_all

```typescript
{
  query: string,
  limit?: number,                    // Default: 5
  entities?: string[]              // Entities to search
}
```

#### batch_get

```typescript
{
  inputs: Array<{
    entity: "gene" | "variant" | "drug" | "disease" | "trial" | "article",
    id: string,
    sections?: string[]
  }>
}
```

### Error Handling

Errors include actionable suggestions. Example:

```json
{
  "code": "ENTITY_NOT_FOUND",
  "message": "Gene 'XYZ' not found",
  "suggestion": "Use gene_search to find valid gene symbols"
}
```

### Rate Limiting

- Token bucket algorithm with smooth backpressure
- Some APIs have dual-rate: faster with API key, slower without

### Environment Variables

| Variable | Required | Description |
|----------|----------|------------|
| `NCBI_API_KEY` | No | Faster PubMed access |
| `ALPHAGENOME_API_KEY` | Yes* | AlphaGenome API |
| `DISGENET_API_KEY` | Yes* | DisGeNET API |
| `UMLS_API_KEY` | Yes* | UMLS API |

* Required if using specific endpoints.

## License

MIT License - see LICENSE file for details.