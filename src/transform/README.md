# transform

Pure transformation functions with no side effects. Each module converts raw API responses into typed domain entities.

## gene.ts

Transforms MyGene.info API responses into `GeneSearchResult` and `GeneResult` types.

### Functions

#### `transformMyGeneHit(hit: MyGeneHit): GeneSearchResult`

Maps a MyGene search hit to a `GeneSearchResult`. Extracts `symbol`, `name`, `entrez_id`, `genomic_coordinates` (first entry from `genomic_pos`), `uniprot_id` (first entry), and `omim_id` (stringified). All optional fields default to `undefined` when absent.

**Input type `MyGeneHit`:**
```
{ symbol: string; name: string; entrezgene?: number;
  genomic_pos?: Array<{ chr: string; start: number; end: number }>;
  uniprot?: string[]; omim?: number[] }
```

**Output:** `GeneSearchResult` (from `entities/gene.ts`)

#### `transformMyGeneResponse(data: MyGeneRecord): GeneResult`

Maps a full MyGene record to a `GeneResult`. Extracts only `symbol`, `name`, and `summary`.

**Input type `MyGeneRecord`:**
```
{ symbol: string; name: string; summary?: string;
  genomic_pos?: Array<{ chr: string; start: number; end: number }>;
  uniprot?: Array<{ SwissProt: string }>; omim?: number[] }
```

**Output:** `GeneResult` (from `entities/gene.ts`)

#### `normalizeAliases(aliases?: string[]): string[]`

Filters out falsy and empty-string values from an alias list. Returns `[]` for `undefined`/`null` input.

## pubmed.ts

Parses PubMed XML into `Article[]` entities using `fast-xml-parser`.

### Functions

#### `parsePubMedXml(xmlString: string): Article[]`

Parses a PubMed XML document (e.g. from NCBI EFetch) into an array of `Article` objects. Returns `[]` if the XML has no `PubmedArticleSet` or contains no articles.

**Parser configuration:**
- Attributes prefixed with `@_`, text nodes named `#text`
- `parseTagValue: false` (no automatic type coercion)
- Explicit `isArray` for: `PubmedArticle`, `Author`, `AbstractText`, `MeshHeading`, `PublicationType`, `ArticleId`, `Chemical`, `Keyword`

**Extraction logic (per article):**
| Field | Source |
|---|---|
| `pmid` | `MedlineCitation.PMID.#text` |
| `doi` | `PubmedData.ArticleIdList` (IdType="doi"), fallback to `ELocationID` (EIdType="doi") |
| `pmcid` | `PubmedData.ArticleIdList` (IdType="pmc") |
| `title` | `Article.ArticleTitle` |
| `abstract` | `Article.Abstract.AbstractText` — joins labeled sections as `"LABEL: text"`, plain strings as-is |
| `authors` | `Article.AuthorList.Author` — formatted as `"LastName ForeName"`, falls back to `LastName` or `CollectiveName` |
| `journal` | `Journal.ISOAbbreviation` with fallback to `Journal.Title` |
| `publication_date` | `JournalIssue.PubDate` — uses `MedlineDate` if present, otherwise joins Year/Month/Day |
| `mesh_headings` | `MeshHeadingList.MeshHeading[].DescriptorName` |
| `publication_types` | `PublicationTypeList.PublicationType[]` |
| `keywords` | `KeywordList.Keyword[]` |
| `chemicals` | `ChemicalList.Chemical[].NameOfSubstance` |
| `source` | Literal `'pubmed'` |

All array fields handle both single-object and array XML representations (PubMed inconsistency). Empty/falsy values are filtered out.

**Output:** `Article[]` (from `entities/article.ts`)
