# transform

Pure transformation functions with no side effects. Each module converts raw API responses into typed domain entities.

## gene.ts

Transforms MyGene.info API responses into `GeneSearchResult` and `GeneResult` types.

### `transformMyGeneHit(hit: MyGeneHit): GeneSearchResult`

Maps a MyGene search hit to a `GeneSearchResult`. Extracts `symbol`, `name`, `entrez_id`, `genomic_coordinates` (first entry from `genomic_pos`), `uniprot_id` (first entry), and `omim_id` (stringified). All optional fields default to `undefined` when absent.

Input shape: `{ symbol, name, entrezgene?, genomic_pos?: Array<{ chr, start, end }>, uniprot?: string[], omim?: number[] }`

### `transformMyGeneResponse(data: MyGeneRecord): GeneResult`

Maps a full MyGene record to a `GeneResult`. Extracts only `symbol`, `name`, and `summary`.

Input shape: `{ symbol, name, summary?, genomic_pos?, uniprot?: Array<{ SwissProt }>, omim?: number[] }`

### `normalizeAliases(aliases?: string[]): string[]`

Filters out falsy and empty-string values from an alias list. Returns `[]` for `undefined`/`null` input.

## pubmed.ts

**Moved to `src/entities/article/transform/pubmed.ts`** — `parsePubMedXml()` now lives alongside the article entity it transforms (fast-xml-parser, `@_`-prefixed attributes, explicit `isArray` for repeating XML elements).

## pdb.ts

### `transformPdbEntry(pdbId: string, raw: RcsbEntryResponse): PdbEntrySummary`

Maps a raw RCSB Data API entry response to a `PdbEntrySummary`. Extracts `pdb_id`, `title`, `experimental_method` (deduplicated), `resolution`, `molecular_weight`, `polymer_count`, `polymer_composition`, `deposition_date`, `release_date`, `organism`, `doi`, `pmid`, `authors`, `space_group`, `unit_cell`, and `container_ids`. All optional fields default to `undefined` when absent.

Input shape (partial): `{ struct?, exptl?, refine?, rcsb_entry_info?, rcsb_accession_info?, rcsb_entry_container_identifiers?, rcsb_primary_citation?, audit_author?, rcsb_entity_source_organism?, symmetry?, cell? }` — see `pdb.ts` for the full typed shape.

## soft.ts

Parser for NCBI GEO SOFT records (`acc.cgi?form=text&targ=self`).

### `parseSoftRecord(text: string): SoftRecord`

Parses a single-entity SOFT record into a `SoftRecord { entity_type, accession, fields: Map<string, string[]>, getSingle(key) }`. Repeated `!Key = value` lines accumulate in the fields map (exact key match); continuation lines (leading whitespace) append to the previous value; `^`/`^^`/`^!` sub-entity lines are skipped (`targ=self` yields one record per fetch).

### `getSoftValue(record: SoftRecord, key: string): string | undefined`

First value for a key, or `undefined` when absent.

### `getSoftValues(record: SoftRecord, key: string): string[]`

All values for a repeated key (empty array when absent).
