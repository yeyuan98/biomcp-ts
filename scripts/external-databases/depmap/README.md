# DepMap → SQLite

Builds a query-ready SQLite database from the **latest DepMap Public release** (currently
26Q1) — CRISPR gene effect/dependency, expression, copy number, somatic mutations, model and
gene metadata, essentiality controls.

## Why a script (and not tools)

DepMap's portal (and every file-download route) is protected by a CAPTCHA for programmatic
clients; only the metadata manifest is open. So acquisition is a **two-step flow**:

1. **One-time human staging** — open <https://depmap.org/portal/data_page/> in a browser,
   pick the **Current Release** tab, download the files listed by the script, and save them
   into `raw/<release>/`.
2. **Automated build** — the script fetches the official manifest
   (`https://depmap.org/portal/api/no-captcha/download/files`), picks the latest
   `DepMap Public <YY>Q<Q>` release by name, **md5-verifies every staged file** against the
   manifest, then streams/parses into SQLite.

## Usage (via the root Makefile)

```bash
make depmap-list RAW_DIR=/path/to/staged/files   # show staging status + what to fetch
make depmap-build RAW_DIR=/path/to/staged/files   # verify + build dist/depmap-<release>.db
```

`RAW_DIR` is optional; the default staging directory is
`scripts/external-databases/depmap/raw/<release>/` (created for you).

Options (pass through the Makefile target or run via `npx tsx` directly):

| Flag | Meaning |
|------|---------|
| `--raw-dir <dir>` | Directory holding the staged release files |
| `--out <file>` | Output database path (default `dist/depmap-<release>.db`) |
| `--datasets <ids>` | Comma-separated subset: `models,genes,crispr_gene_effect,crispr_gene_dependency,common_essentials,expression_tpm,cn_gene,mutations` |
| `--list` | Print release + staging status only (never builds) |
| `--manifest <file>` | Use a saved manifest CSV instead of the live endpoint (offline) |

**Exit codes:** `0` ok · `1` files missing (staging plan printed) · `2` md5 mismatch
(re-stage the listed files) · `3` manifest unavailable.

## Source files (pinned)

| dataset | file | table |
|---------|------|-------|
| models | `Model.csv` | `models` (all 49 columns, snake_cased; pinned baseline — renames fail loudly) |
| genes | `Gene.csv` | `genes` |
| crispr_gene_effect | `CRISPRGeneEffect.csv` | `gene_effect` |
| crispr_gene_dependency | `CRISPRGeneDependency.csv` | `gene_dependency` |
| common_essentials | `AchillesCommonEssentialControls.csv` + `AchillesNonessentialControls.csv` | `essentiality_controls` |
| expression_tpm | `OmicsExpressionTPMLogp1HumanProteinCodingGenes.csv` | `expression_tpm` |
| cn_gene | `OmicsCNGeneWGS.csv` | `cn_gene` |
| mutations | `OmicsSomaticMutations.csv` | `mutations` (24 curated columns) |

If a future release renames a pinned file the build **fails with the actual release file
list**; updating `datasets.ts` is then a one-line change.

## Schema

Long (tidy) layout — wide matrices are impossible in SQLite (2,000-column limit) and wasteful:

```sql
gene_effect | gene_dependency | expression_tpm | cn_gene
  (model_id TEXT, gene_symbol TEXT, value REAL,
   PRIMARY KEY (model_id, gene_symbol)) WITHOUT ROWID
  + INDEX idx_<table>_gene (<table>.gene_symbol)   -- PK serves model-direction lookups

mutations (model_id, hugo_symbol, entrez_gene_id, chromosome, position, ref, alt,
  variant_type, variant_info, dna_change, protein_change, gt, ref_count, alt_count,
  af, dp, molecular_consequence, vep_impact, is_hotspot, hess_driver, hess_signature,
  likely_lof, gnomad_e_af, gnomad_g_af) + gene/model indexes

models (model_id TEXT PRIMARY KEY, ... all Model.csv columns, snake_cased)
genes (gene_symbol TEXT PRIMARY KEY, entrez_id INTEGER, gene_name TEXT) + entrez index
essentiality_controls (gene_symbol, category, PK(gene_symbol, category))
  -- category: 'common_essential' | 'nonessential'
depmap_meta (key, value)   -- release, release_date, imported_at, manifest_endpoint,
                            -- script_version, models_column_map, models_pinned_columns
dataset (dataset_id, filename, row_count, imported_at)
```

**Semantics to know when querying:**

- `gene_effect` (Chronos): **more negative = stronger dependency**; `gene_dependency` is the
  probability (0–1) counterpart; `expression_tpm` is log2(TPM+1) (higher = more); `cn_gene`
  is absolute copy number.
- Omics matrices carry multiple profiles per model; only rows with
  `IsDefaultEntryForModel = Yes` are ingested (non-default profiles are skipped and counted).
- Empty / `NaN` matrix cells are skipped (sparse storage); duplicate gene columns fail the
  build; duplicate `(model, gene)` pairs are treated as a source-shape error.
- Known coverage gaps (26Q1): 589/19,955 CN gene columns are ENSG-only or `_PAR_Y` entries
  absent from `Gene.csv`; ~45 mutation `hugo_symbol`s are not in `genes`; some models lack
  some data types (946 without CRISPR, 435 without expression, 1,036 without CN, 186
  without mutations); a couple of control-list entries are bare Entrez IDs.

## Measured (26Q1 reference build)

~3 minutes, 5.2 GB output, ~10 GB free disk recommended. Row counts: models 2,154 · genes
44,083 · controls 2,028 · gene_effect 21,498,297 · gene_dependency 21,498,297 ·
expression_tpm 33,030,585 · cn_gene 21,402,992 · mutations 1,172,688. Canonical queries
(gene → models, model → genes) are index-served in < 10 ms.

## Querying

Use the built-in read-only db tools (see [docs/DATABASE.md](../../../docs/DATABASE.md)):

```bash
DB_TYPE=sqlite DB_SQLITE_PATH=scripts/external-databases/depmap/dist/depmap-26Q1.db npx .
```

```sql
SELECT ge.model_id, ge.value, m.CellLineName
FROM gene_effect ge JOIN models m ON m.model_id = ge.model_id
WHERE ge.gene_symbol = 'KRAS' ORDER BY ge.value ASC LIMIT 10;
```

Prefer explicit `LIMIT`s — the tables have tens of millions of rows.

## License & citation

DepMap Public releases are CC BY 4.0. Cite: DepMap, Broad (2026). DepMap 26Q1 Public.
<https://depmap.org/portal/download/all/>. Note that DepMap's current terms restrict
commercial use of newly generated data (including training AI models for commercial
purposes) — review the portal terms before redistributing databases built here.

Node >= 22.13 required (`node:sqlite`); Node prints an `ExperimentalWarning` for the
built-in SQLite module on 22.x — harmless.
