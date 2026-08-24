import { XMLParser } from 'fast-xml-parser';

export interface SraRun {
  accession: string;
  total_spots?: number;
  total_bases?: number;
  size_bytes?: number;
  published?: string;
}

export interface SraLibrary {
  strategy?: string;
  source?: string;
  selection?: string;
  layout: 'PAIRED' | 'SINGLE';
}

export interface SraRecord {
  experiment_accession: string;
  experiment_title?: string;
  study_accession?: string;
  study_title?: string;
  study_type?: string;
  bioproject?: string;
  sample_accession?: string;
  sample_title?: string;
  organism?: string;
  taxon_id?: string;
  library: SraLibrary;
  platform_vendor?: string;
  instrument_model?: string;
  run_accessions: SraRun[];
  submission_accession?: string;
  center_name?: string;
  experiment_attributes?: Record<string, string>;
}

const REPEATED_ELEMENTS = new Set([
  'EXPERIMENT_PACKAGE',
  'EXPERIMENT',
  'RUN_SET',
  'RUN',
  'EXPERIMENT_ATTRIBUTE',
  'EXTERNAL_ID',
  'SAMPLE_ATTRIBUTE',
]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseTagValue: false,
  parseAttributeValue: false,
  isArray: (name: string) => REPEATED_ELEMENTS.has(name),
});

function asObj(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function asArr(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string') return value === '' ? undefined : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value && typeof value === 'object') {
    return asString((value as Record<string, unknown>)['#text']);
  }
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  const text = asString(value);
  if (text === undefined) return undefined;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Detect the HTTP-200 error documents SRA efetch returns: an <ERROR>
 * element under EXPERIMENT_PACKAGE_SET (or inside a package).
 */
export function assertNoSraXmlError(node: Record<string, unknown> | undefined): void {
  if (!node) return;
  const direct = asString(node['ERROR']);
  if (direct !== undefined) {
    throw new Error(`SRA efetch error: ${direct}`);
  }
  for (const pkg of asArr(node['EXPERIMENT_PACKAGE'])) {
    const pkgError = asString(asObj(pkg)?.['ERROR']);
    if (pkgError !== undefined) {
      throw new Error(`SRA efetch error: ${pkgError}`);
    }
  }
}

export function parseExperimentPackageSet(xml: string): SraRecord[] {
  const trimmed = xml.trimStart();
  if (trimmed.startsWith('Error:')) {
    throw new Error(`SRA efetch error: ${trimmed.slice(0, 300)}`);
  }

  let parsed: unknown;
  try {
    parsed = parser.parse(xml);
  } catch (e) {
    throw new Error(`Malformed SRA EXPERIMENT_PACKAGE XML: parse failed (${(e as Error).message})`, { cause: e });
  }

  const root = asObj(asObj(parsed)?.['EXPERIMENT_PACKAGE_SET']);
  if (!root) {
    throw new Error('Malformed SRA EXPERIMENT_PACKAGE XML: missing EXPERIMENT_PACKAGE_SET root element');
  }
  assertNoSraXmlError(root);

  const records: SraRecord[] = [];
  const packages = asArr(root['EXPERIMENT_PACKAGE']);
  for (let i = 0; i < packages.length; i++) {
    try {
      records.push(extractRecord(packages[i]));
    } catch (e) {
      throw new Error(`Malformed SRA EXPERIMENT_PACKAGE XML: package ${i}: ${(e as Error).message}`, { cause: e });
    }
  }
  return records;
}

function extractRecord(pkg: unknown): SraRecord {
  const pkgObj = asObj(pkg);
  if (!pkgObj) throw new Error('EXPERIMENT_PACKAGE is not an element');

  const experiment = asObj(asArr(pkgObj['EXPERIMENT'])[0]);
  const experimentAccession = asString(experiment?.['@_accession']);
  if (!experiment || !experimentAccession) {
    throw new Error('missing EXPERIMENT accession attribute');
  }

  const design = asObj(experiment['DESIGN']);
  const libraryDescriptor = asObj(design?.['LIBRARY_DESCRIPTOR']);
  const libraryLayout = asObj(libraryDescriptor?.['LIBRARY_LAYOUT']);
  const library: SraLibrary = {
    strategy: asString(libraryDescriptor?.['LIBRARY_STRATEGY']),
    source: asString(libraryDescriptor?.['LIBRARY_SOURCE']),
    selection: asString(libraryDescriptor?.['LIBRARY_SELECTION']),
    layout: libraryLayout && 'PAIRED' in libraryLayout ? 'PAIRED' : 'SINGLE',
  };

  const platform = asObj(experiment['PLATFORM']);
  let platformVendor: string | undefined;
  let instrumentModel: string | undefined;
  if (platform) {
    const vendorKey = Object.keys(platform).find(key => !key.startsWith('@_') && key !== '#text');
    if (vendorKey) {
      platformVendor = vendorKey;
      instrumentModel = asString(asObj(platform[vendorKey])?.['INSTRUMENT_MODEL']);
    }
  }

  const study = asObj(pkgObj['STUDY']);
  const studyDescriptor = asObj(study?.['DESCRIPTOR']);
  const sample = asObj(pkgObj['SAMPLE']);
  const sampleName = asObj(sample?.['SAMPLE_NAME']);
  const submission = asObj(pkgObj['SUBMISSION']);

  return {
    experiment_accession: experimentAccession,
    experiment_title: asString(experiment['TITLE']),
    study_accession:
      asString(study?.['@_accession']) ??
      asString(asObj(experiment['STUDY_REF'])?.['@_accession']),
    study_title: asString(studyDescriptor?.['STUDY_TITLE']),
    study_type: asString(asObj(studyDescriptor?.['STUDY_TYPE'])?.['@_existing_study_type']),
    bioproject: extractBioproject(study),
    sample_accession:
      asString(sample?.['@_accession']) ??
      asString(asObj(design?.['SAMPLE_DESCRIPTOR'])?.['@_accession']),
    sample_title: asString(sample?.['TITLE']),
    organism: asString(sampleName?.['SCIENTIFIC_NAME']),
    taxon_id: asString(sampleName?.['TAXON_ID']),
    library,
    platform_vendor: platformVendor,
    instrument_model: instrumentModel,
    run_accessions: extractRuns(pkgObj),
    submission_accession: asString(submission?.['@_accession']),
    center_name:
      asString(submission?.['@_center_name']) ??
      asString(studyDescriptor?.['CENTER_NAME']),
    experiment_attributes: extractExperimentAttributes(experiment),
  };
}

function extractBioproject(study: Record<string, unknown> | undefined): string | undefined {
  const externalIds = asArr(asObj(study?.['IDENTIFIERS'])?.['EXTERNAL_ID']);
  for (const external of externalIds) {
    const externalObj = asObj(external);
    if (externalObj && asString(externalObj['@_namespace']) === 'BioProject') {
      const value = asString(externalObj['#text']);
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

function extractRuns(pkgObj: Record<string, unknown>): SraRun[] {
  const runs: SraRun[] = [];
  for (const runSet of asArr(pkgObj['RUN_SET'])) {
    for (const run of asArr(asObj(runSet)?.['RUN'])) {
      const runObj = asObj(run);
      const accession = asString(runObj?.['@_accession']);
      if (!accession) continue;
      runs.push({
        accession,
        total_spots: asNumber(runObj?.['@_total_spots']),
        total_bases: asNumber(runObj?.['@_total_bases']),
        size_bytes: asNumber(runObj?.['@_size']),
        published: asString(runObj?.['@_published']),
      });
    }
  }
  return runs;
}

function extractExperimentAttributes(
  experiment: Record<string, unknown>
): Record<string, string> | undefined {
  const attributes: Record<string, string> = {};
  const attributeNodes = asArr(asObj(experiment['EXPERIMENT_ATTRIBUTES'])?.['EXPERIMENT_ATTRIBUTE']);
  for (const attribute of attributeNodes) {
    const attributeObj = asObj(attribute);
    const tag = asString(attributeObj?.['TAG']);
    const value = asString(attributeObj?.['VALUE']);
    if (tag !== undefined && value !== undefined) {
      attributes[tag] = value;
    }
  }
  return Object.keys(attributes).length > 0 ? attributes : undefined;
}
