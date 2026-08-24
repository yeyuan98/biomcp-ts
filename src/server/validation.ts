import { z } from 'zod';

export interface ValidationResult {
  success: boolean;
  errors?: Array<{ path: string; message: string }>;
  data?: unknown;
}

export function validateInput<T extends z.ZodType>(
  schema: T,
  data: unknown
): ValidationResult {
  const result = schema.safeParse(data);
  
  if (result.success) {
    return { success: true, data: result.data };
  }
  
  const errors = result.error.errors.map(e => ({
    path: e.path.join('.'),
    message: e.message,
  }));
  
  return { success: false, errors };
}

export const InputValidation = {
  geneSymbol: z.string().min(1).max(50).regex(/^[A-Za-z0-9\-_]+$/, 'Invalid gene symbol format'),
  variantId: z.string().min(1).max(100),
  drugName: z.string().min(1).max(200),
  diseaseQuery: z.string().min(1).max(200),
  articleId: z.string().regex(/^(?:\d+|PMC\d+|10\.\d{4,}\/\S+)$/i, 'Article ID must be a PMID (numeric), PMCID (PMC...), or DOI (10.x/...)'),
  nctId: z.string().regex(/^NCT\d{8}$/, 'NCT ID must be in format NCT########'),
  patentId: z.string().regex(/^[A-Za-z]{2}\s?(?:RE|PP|H)?\s?\d{5,}\s?(?:[A-Za-z]\d{0,2})?$/, 'Patent ID must be a publication number like US11027025B2, EP3904939, US20260240819A1'),
  geoAccession: z.string().regex(/^(GSE|GSM|GPL|GDS)\d+$/, 'GEO accession must be a series (GSE...), sample (GSM...), platform (GPL...), or curated dataset (GDS...) like GSE183947'),
  sraAccession: z.string().regex(/^SR[PXRS]\d+$/, 'NCBI SRA accession must be SRP/SRX/SRR/SRS followed by digits, like SRR14432476'),
  genbankAccession: z.string().regex(/^[A-Z]{1,6}_?\d+(\.\d+)?$/i, 'GenBank/RefSeq accession like NC_000023.11, NG_017013.2, or KJ668569.2'),
  limit: z.number().int().min(1).max(100),
  offset: z.number().int().min(0),
};

export function formatValidationErrors(errors: Array<{ path: string; message: string }>): string {
  const messages = errors.map(e => `${e.path}: ${e.message}`);
  return `Validation failed:\n- ${messages.join('\n- ')}\n\nPlease check the input format and try again.`;
}

export function isValidEntityInput(entity: string, id: string): boolean {
  switch (entity) {
    case 'gene':
      return InputValidation.geneSymbol.safeParse(id).success;
    case 'variant':
      return InputValidation.variantId.safeParse(id).success;
    case 'drug':
      return InputValidation.drugName.safeParse(id).success;
    case 'disease':
      return InputValidation.diseaseQuery.safeParse(id).success;
    case 'trial':
      return InputValidation.nctId.safeParse(id).success || InputValidation.articleId.safeParse(id).success;
    case 'article':
      return InputValidation.articleId.safeParse(id).success;
    case 'patent':
      return InputValidation.patentId.safeParse(id).success;
    case 'geo':
      return InputValidation.geoAccession.safeParse(id).success;
    case 'sra':
      return InputValidation.sraAccession.safeParse(id).success;
    case 'genbank':
      return InputValidation.genbankAccession.safeParse(id).success;
    default:
      return false;
  }
}

export function getEntitySuggestions(entity: string): string {
  switch (entity) {
    case 'gene':
      return 'Use gene_search to find valid gene symbols (e.g., "BRAF", "TP53", "KRAS")';
    case 'variant':
      return 'Use variant_search to find valid variant IDs (e.g., "rs1134882", "chr7:140753336")';
    case 'drug':
      return 'Use drug_search to find valid drug names (e.g., "imatinib", "vemurafenib")';
    case 'disease':
      return 'Use disease_search to find valid disease IDs (e.g., "C0012345", "MONDO:0005180")';
    case 'trial':
      return 'Use trial_search to find valid NCT IDs (format: NCT########)';
    case 'article':
      return 'Use article_search to find valid article identifiers (PMID, PMCID, or DOI)';
    case 'patent':
      return 'Use patent_search to find valid publication numbers (e.g., "US11027025B2", "EP3904939B1")';
    case 'geo':
      return 'Use geo_search to find valid GEO accessions (GSE series, GSM sample, GPL platform — e.g., "GSE183947")';
    case 'sra':
      return 'Use sra_search to find valid NCBI SRA accessions (SRP/SRX/SRR/SRS — e.g., "SRR14432476")';
    case 'genbank':
      return 'Use genbank_search to find valid nucleotide accessions (e.g., "NC_000023.11", "KJ668569.2")';
    default:
      return 'Check the entity type and try again.';
  }
}