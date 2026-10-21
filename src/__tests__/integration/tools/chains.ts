/**
 * Shared search→get chaining table (issue #161).
 *
 * This is a plain module (NOT a .test.ts file) so it is picked up by NEITHER
 * jest testMatch pattern (unit: any .test.ts under src/__tests__; integration:
 * any .test.ts under src/__tests__/integration) and can be
 * imported by both tiers:
 *
 *   - `src/__tests__/integration/tools/chaining-parity.test.ts` walks every
 *     entry live (integration tier, `npm run test:integration`).
 *   - `src/__tests__/server/chaining-parity-coverage.test.ts` asserts the
 *     docstring-advertised links stay in sync with this table (unit tier).
 *
 * The rule this table enforces: every row a search tool returns must be
 * consumable by the get-tool its docstring advertises — the invariant that
 * caught #136 (sra_search handing out ENA/DDBJ accessions sra_get rejected,
 * fixed in PR #153). When a NEW cross-tool link is advertised in a tool
 * description, the offline coverage test fails until either a matching entry
 * is added here (preferred) or the mention is classified in
 * INCIDENTAL_MENTIONS below with an explicit justification.
 */

/** One search→get hop: which row field feeds which argument of which get tool. */
export interface ChainLink {
  /** Result-row field carrying the get-tool argument value. */
  field: string;
  /** The get-tool to feed the value to. */
  getTool: string;
  /**
   * Argument name the get tool expects (frequently differs from the row
   * field — e.g. patent rows carry `publication_number`, patent_get takes
   * `patent_id`; article rows carry `pmid`, article_get takes `id`).
   */
  getArg: string;
  /**
   * Documented limitation marker (#124 precedent): when the field is
   * legitimately absent on the row, the walker passes with the marker in
   * the test name instead of failing. Must cite the tracking issue.
   */
  optionalIfMissing?: string;
  /**
   * Select which row of the result to read (default: the first row).
   * `equals` compares against the raw field value; `pattern` is a regex
   * source tested against String(value). Used where the deterministic pin
   * is not the first row (e.g. the rs-prefixed variation features of
   * ensembl_region) or to pin an exact-accession row (geo GSE183947).
   */
  rowMatch?: { field: string; equals?: string; pattern?: string };
}

/** One walked chain: a fixed deterministic search call plus its get hops. */
export interface ChainSpec {
  /** The tool whose rows are walked (search tools, plus detail tools that
   *  advertise "cross-references for chaining", e.g. geo_get). */
  sourceTool: string;
  /** Deterministic arguments for the source call (pins reused from the
   *  per-tool integration suites wherever they exist). */
  args: Record<string, unknown>;
  /**
   * Where the rows live in the response: `'array'` for bare-array replies,
   * a key name for envelope replies ({ results | studies | patents | … }),
   * or `'self'` for single-record tools (ensembl_lookup).
   */
  rows: 'array' | 'self' | string;
  links: ChainLink[];
}

/**
 * Chains a tool DESCRIPTION advertises (cross-tool refs only — a tool naming
 * itself, like geo_get pointing follow-ups at geo_get for GSM/GPL records,
 * is not a chain). Every pair here MUST have a matching CHAIN_TABLE entry —
 * the offline coverage test enforces the subset relation.
 */
export const ADVERTISED_LINKS: Record<string, string[]> = {
  geo_search: ['geo_get', 'sra_get', 'article_get'],
  // geo_get's "cross-references for chaining" sentence (self-refs to
  // geo_get for GSM/GPL rows excluded per cross-tool-only rule).
  geo_get: ['sra_get', 'article_get'],
  sra_search: ['sra_get'],
  genbank_search: ['genbank_get', 'genbank_genes'],
  ensembl_lookup: ['gene_get'],
  ensembl_region: ['gene_get', 'variant_get'],
};

/**
 * Description mentions of get-tools that are NOT advertised row-field
 * chains. Every entry needs an explicit reason — this list is the pressure
 * valve that keeps the token scan honest, so additions get code-reviewed
 * for whether they belong in ADVERTISED_LINKS (with a CHAIN_TABLE entry)
 * instead.
 */
export const INCIDENTAL_MENTIONS: Record<string, Array<{ token: string; reason: string }>> = {
  batch_get: [
    {
      token: 'article_get',
      reason: 'output-mode guidance ("for inline text use article_get with fulltext_output=inline"), not a search-row link',
    },
  ],
  sra_get: [
    {
      token: 'geo_get',
      reason: 'back-reference naming where sra accessions come FROM ("chain from geo_get (sra field)"), not a link out of sra_get rows',
    },
  ],
  ensembl_region: [
    {
      token: 'genbank_get',
      reason: 'sequence-text guidance; region rows carry coordinates, not GenBank accessions — no row field feeds genbank_get',
    },
  ],
  ensembl_consequence: [
    {
      token: 'variant_get',
      reason:
        'preference note for KNOWN variants ("variant_get additionally provides deep pre-computed scores"); colocated_variants ids are source-heterogeneous (ClinVar/COSMIC) and not every id form is a variant_get key',
    },
  ],
  genbank_genes: [
    {
      token: 'gene_get',
      reason:
        'TODO-extensible: description claims entrezgene ids are "usable directly with gene_get", but gene_get resolves HGNC symbols (q=symbol:"…"), not entrez ids — walking this needs an id→symbol bridge (e.g. gene_search on the numeric id, or teaching gene_get numeric input) before it can be a green chain entry',
    },
  ],
};

/**
 * The walked chain table. Entries beyond ADVERTISED_LINKS cover the
 * structural-but-unadvertised chains the issue lists explicitly
 * (article/variant/patent/drug/disease/trial) so the walker generalizes the
 * hand-written per-case pins.
 *
 * TODO-extensible (advertised but not walked — see INCIDENTAL_MENTIONS):
 *   - genbank_genes → gene_get (entrez-id vs symbol key mismatch, above).
 */
export const CHAIN_TABLE: ChainSpec[] = [
  {
    // Pin: PR #143 / geo integration suite — GSE183947 links SRP336638.
    sourceTool: 'geo_search',
    args: { query: 'GSE183947', entry_type: 'gse', limit: 5 },
    rows: 'array',
    links: [
      {
        field: 'accession',
        getTool: 'geo_get',
        getArg: 'accession',
        rowMatch: { field: 'accession', equals: 'GSE183947' },
      },
      {
        // sra_project is legitimately absent when NCBI has not linked the
        // study to the series (#124); geo_get(accession).sra is the reliable route.
        field: 'sra_project',
        getTool: 'sra_get',
        getArg: 'accession',
        optionalIfMissing: 'geo-sra-absent (#124)',
        rowMatch: { field: 'accession', equals: 'GSE183947' },
      },
      {
        // pubmed_ids is number[] — the walker takes the first element.
        field: 'pubmed_ids',
        getTool: 'article_get',
        getArg: 'id',
        rowMatch: { field: 'accession', equals: 'GSE183947' },
      },
    ],
  },
  {
    // geo_get's advertised "cross-references for chaining" (detail side):
    // sra → sra_get, pubmed_ids → article_get. Same GSE183947 pin.
    sourceTool: 'geo_get',
    args: { accession: 'GSE183947' },
    rows: 'self',
    links: [
      { field: 'sra', getTool: 'sra_get', getArg: 'accession' },
      { field: 'pubmed_ids', getTool: 'article_get', getArg: 'id' },
    ],
  },
  {
    // Pin: sra integration suite — SRP356657 (bioproject PRJNA800381).
    sourceTool: 'sra_search',
    args: { query: 'SRP356657', limit: 5 },
    rows: 'array',
    links: [
      {
        field: 'experiment_accession',
        getTool: 'sra_get',
        getArg: 'accession',
        rowMatch: { field: 'study_accession', equals: 'SRP356657' },
      },
      {
        field: 'first_run_accession',
        getTool: 'sra_get',
        getArg: 'accession',
        rowMatch: { field: 'study_accession', equals: 'SRP356657' },
      },
    ],
  },
  {
    // Structural chain (unadvertised in the docstring; issue table entry).
    // PubMed resolves bare numeric queries as PMID lookups.
    sourceTool: 'article_search',
    args: { query: '21639808', source: 'pubmed', limit: 3 },
    rows: 'results',
    links: [{ field: 'pmid', getTool: 'article_get', getArg: 'id' }],
  },
  {
    // Structural chain; trial integration suite pins query 'breast cancer'
    // (rows carry ^NCT\d+$ nct_ids) and trial_get by nct_id.
    sourceTool: 'trial_search',
    args: { query: 'breast cancer', limit: 5 },
    rows: 'studies',
    links: [{ field: 'nct_id', getTool: 'trial_get', getArg: 'nct_id' }],
  },
  {
    // Structural chain; drug_get is keyed by NAME, not chembl_id —
    // the row field and the get arg happen to coincide here.
    sourceTool: 'drug_search',
    args: { query: 'imatinib' },
    rows: 'results',
    links: [{ field: 'name', getTool: 'drug_get', getArg: 'name' }],
  },
  {
    // Structural chain; breast cancer → MONDO:0007254 pinned in the
    // disease integration suite (disease_get also takes MESH ids).
    sourceTool: 'disease_search',
    args: { query: 'breast cancer' },
    rows: 'results',
    links: [{ field: 'disease_id', getTool: 'disease_get', getArg: 'disease_id' }],
  },
  {
    // Structural chain; ppubs backend pinned in the patent integration
    // suite (US-only → publication_number is always patent_get-shaped).
    sourceTool: 'patent_search',
    args: { query: 'crispr', source: 'ppubs', limit: 3, seminal: false },
    rows: 'patents',
    links: [
      { field: 'publication_number', getTool: 'patent_get', getArg: 'patent_id' },
    ],
  },
  {
    // Structural chain; BRAF V600E pinned in the variant integration suite.
    // Row id is dbsnp.rsid (fallback: myvariant _id) — both variant_get keys.
    sourceTool: 'variant_search',
    args: { gene: 'BRAF', hgvsp: 'V600E' },
    rows: 'array',
    links: [{ field: 'id', getTool: 'variant_get', getArg: 'id' }],
  },
  {
    // Advertised: "chain accessions into genbank_get or genbank_genes".
    // Pin: genbank integration suite — TP53[Gene Name] human query.
    sourceTool: 'genbank_search',
    args: { query: 'TP53[Gene Name] AND Homo sapiens[Organism]', limit: 3 },
    rows: 'array',
    links: [
      { field: 'accession', getTool: 'genbank_get', getArg: 'accession' },
      { field: 'accession', getTool: 'genbank_genes', getArg: 'accession' },
    ],
  },
];

/**
 * Ensembl-dependent chains (issue #161 walker, tier split): same walker,
 * same enforcement, but their SEARCH leg is Ensembl REST — the #182 known
 * GitHub-runner offender. Ensembl-side degradation was observed leaking
 * into the GATING integration tier through these chains (run 39535999218:
 * the region page carried no rs-variation row while the same window's
 * ensembl-tools offender-tier test also failed). They run in their own
 * file, chained-parity-ensembl.test.ts, which ci.yml routes through the
 * non-gating known-offender tier on GH Actions; local runs stay
 * authoritative. The offline coverage test enforces ADVERTISED_LINKS ⊆
 * CHAIN_TABLE ∪ ENSEMBL_CHAIN_TABLE, so the ensembl docstring links stay
 * covered by the split table.
 */
export const ENSEMBL_CHAIN_TABLE: ChainSpec[] = [
  {
    // Advertised: "for rich human gene annotation use gene_get instead" —
    // the resolved record's symbol IS gene_get's key. Pin: BRAF lookup.
    sourceTool: 'ensembl_lookup',
    args: { gene_or_id: 'BRAF' },
    rows: 'self',
    links: [{ field: 'symbol', getTool: 'gene_get', getArg: 'symbol' }],
  },
  {
    // Advertised: "chain IDs into gene_get / variant_get". Pin: the 20 kb
    // BRAF-spanning interval from the ensembl integration suite (full-span
    // variation below the 50 kb cap; genes include ENSG ids + symbols).
    // limit 50: variation features must make the returned page — under
    // thin/degraded responses the tighter page occasionally carried genes
    // only (run 39535999218).
    sourceTool: 'ensembl_region',
    args: { region: '7:140450000-140470000', features: ['gene', 'variation'], limit: 50 },
    rows: 'features',
    links: [
      {
        field: 'symbol',
        getTool: 'gene_get',
        getArg: 'symbol',
        rowMatch: { field: 'type', equals: 'gene' },
      },
      {
        field: 'id',
        getTool: 'variant_get',
        getArg: 'id',
        // rs-prefixed ids select variation features unambiguously (gene ids
        // are ENSG…, transcripts ENST…) and are variant_get's natural key.
        rowMatch: { field: 'id', pattern: '^rs\\d+$' },
      },
    ],
  },
];
