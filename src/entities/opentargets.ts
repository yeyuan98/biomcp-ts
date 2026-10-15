import { connectionManager } from '../connections/manager.js';

/**
 * Shared OpenTargets (OT) association lookups — the keyless GraphQL fallback
 * used by both association directions when DisGeNET is unavailable (no
 * DISGENET_API_KEY, or the API erroring). Both helpers follow the OT query
 * structuring convention of this codebase (POST JSON to the v4 GraphQL
 * endpoint via the registered `opentargets` connection; see the mechanisms /
 * fetchTargets lookups in drug.ts) and THROW on failure — callers own the
 * `_error` shaping so each direction can combine the DisGeNET and OpenTargets
 * failure reasons honestly.
 */

/** Row emitted for the gene→disease direction (gene_get diseases section). */
export interface OtDiseaseAssociationRow {
  name: string;
  source: 'opentargets';
}

/** Row emitted for the disease→gene direction (disease_get gene_associations). */
export interface OtGeneAssociationRow {
  gene_symbol: string;
  name: string;
  disease_name?: string;
  score?: number;
  source: 'opentargets';
}

const OT_SEARCH_TARGET_QUERY = `query($symbol: String!) {
  search(queryString: $symbol, entityNames: ["target"], page: {index: 0, size: 1}) {
    hits { id name entity }
  }
}`;

const OT_ASSOCIATED_DISEASES_QUERY = `query($ensemblId: String!) {
  target(ensemblId: $ensemblId) {
    associatedDiseases(page: {index: 0, size: 20}) {
      rows { disease { id name } score }
    }
  }
}`;

/**
 * Gene symbol → associated diseases via OpenTargets: search resolves the
 * symbol to its Ensembl target id, then `associatedDiseases` lists the
 * diseases. Throws when the symbol cannot be resolved (descriptive message,
 * kept verbatim by callers' error shaping).
 */
export async function otDiseasesForGene(
  geneSymbol: string,
  signal?: AbortSignal
): Promise<OtDiseaseAssociationRow[]> {
  const conn = connectionManager.getConnection('opentargets');

  const searchRaw = await conn.request(
    OT_SEARCH_TARGET_QUERY,
    { symbol: geneSymbol },
    { signal, rootField: 'search' }
  ) as any;
  const ensemblId = searchRaw?.data?.search?.hits?.[0]?.id;
  if (!ensemblId) {
    throw new Error(`Could not resolve Ensembl ID for '${geneSymbol}' via OpenTargets. Gene symbol may be invalid.`);
  }

  const targetRaw = await conn.request(
    OT_ASSOCIATED_DISEASES_QUERY,
    { ensemblId },
    { signal, rootField: 'target' }
  ) as any;
  const rows = targetRaw?.data?.target?.associatedDiseases?.rows || [];

  return rows
    .map((r: any) => ({ name: r.disease?.name || '', source: 'opentargets' as const }))
    .filter((d: OtDiseaseAssociationRow) => d.name);
}

/** OT's `efoId` argument takes underscore-form ontology codes (MONDO_0005105). */
function toOtEfoId(diseaseId: string): string {
  return diseaseId.replace(/^([A-Za-z]+):([A-Za-z0-9._-]+)$/, '$1_$2');
}

const OT_ASSOCIATED_TARGETS_QUERY = `query($efoId: String!) {
  disease(efoId: $efoId) {
    id name
    associatedTargets(page: {index: 0, size: 20}) {
      rows { target { id approvedSymbol } score }
    }
  }
}`;

const OT_SEARCH_DISEASE_QUERY = `query($name: String!) {
  search(queryString: $name, entityNames: ["disease"], page: {index: 0, size: 1}) {
    hits { id name entity }
  }
}`;

/**
 * Disease → associated genes via OpenTargets (the REVERSE direction of
 * otDiseasesForGene): the `disease(efoId:)` field accepts MONDO ids directly
 * in underscore form (mydisease document ids work as-is after `:` → `_`),
 * and when the id does not resolve, an optional disease name falls back to
 * an OT disease search first — mirroring the resolution chain of
 * diseaseToDrugs. Throws when neither path resolves the disease.
 */
export async function otGenesForDisease(
  diseaseId: string,
  diseaseName?: string,
  signal?: AbortSignal
): Promise<OtGeneAssociationRow[]> {
  const conn = connectionManager.getConnection('opentargets');

  const fetchDisease = async (efoId: string): Promise<any | null> => {
    const raw = await conn.request(
      OT_ASSOCIATED_TARGETS_QUERY,
      { efoId },
      { signal, rootField: 'disease' }
    ) as any;
    return raw?.data?.disease ?? null;
  };

  let disease: any = null;
  let directError: unknown;
  try {
    disease = await fetchDisease(toOtEfoId(diseaseId));
  } catch (error) {
    // Transport/GraphQL failure on the direct lookup — remember it so the
    // final error can carry the REAL reason (never mask an outage as
    // "could not resolve"), but still try the name-search recovery below.
    directError = error;
  }

  if (!disease && diseaseName) {
    try {
      const searchRaw = await conn.request(
        OT_SEARCH_DISEASE_QUERY,
        { name: diseaseName },
        { signal, rootField: 'search' }
      ) as any;
      const otDiseaseId = searchRaw?.data?.search?.hits?.[0]?.id;
      if (otDiseaseId) {
        disease = await fetchDisease(otDiseaseId);
      }
    } catch {
      // Fall through to the final error below.
    }
  }

  if (!disease) {
    if (directError !== undefined) {
      throw directError instanceof Error ? directError : new Error(String(directError));
    }
    throw new Error(
      `Could not resolve disease '${diseaseId}' in OpenTargets. Disease id may be outside OpenTargets' ontology coverage.`
    );
  }

  const rows = disease.associatedTargets?.rows || [];
  const diseaseNameFromOt: string | undefined = disease.name || undefined;

  return rows
    .map((r: any) => ({
      gene_symbol: r.target?.approvedSymbol || '',
      name: r.target?.approvedSymbol || '',
      disease_name: diseaseNameFromOt,
      score: typeof r.score === 'number' ? r.score : undefined,
      source: 'opentargets' as const,
    }))
    .filter((r: OtGeneAssociationRow) => r.gene_symbol);
}
