import { jest } from '@jest/globals';
import { connectionManager } from '../../connections/manager.js';
import { parseExperimentPackageSet } from '../../entities/sra/transform/experiment-package.js';
import { sraSearch, sraGet } from '../../entities/sra/index.js';

// Verified EXPERIMENT_PACKAGE_SET shape (element-attribute accessions,
// one package per experiment, RUN stats as attributes).
const SRP_MULTI_PACKAGE_XML = `<?xml version="1.0" encoding="UTF-8"  ?>
<EXPERIMENT_PACKAGE_SET>
<EXPERIMENT_PACKAGE>
<EXPERIMENT accession="SRX13898298" alias="run1 alias">
  <IDENTIFIERS><PRIMARY_ID>SRX13898298</PRIMARY_ID><SUBMITTER_ID>submitter-1</SUBMITTER_ID></IDENTIFIERS>
  <TITLE>Gut metagenome experiment 1</TITLE>
  <STUDY_REF accession="SRP356657"><IDENTIFIERS><PRIMARY_ID>SRP356657</PRIMARY_ID></IDENTIFIERS></STUDY_REF>
  <DESIGN>
    <DESIGN_DESCRIPTION>Whole metagenome sequencing</DESIGN_DESCRIPTION>
    <SAMPLE_DESCRIPTOR accession="SRS11761419"><IDENTIFIERS><PRIMARY_ID>SRS11761419</PRIMARY_ID></IDENTIFIERS></SAMPLE_DESCRIPTOR>
    <LIBRARY_DESCRIPTOR>
      <LIBRARY_NAME/>
      <LIBRARY_STRATEGY>WGS</LIBRARY_STRATEGY>
      <LIBRARY_SOURCE>METAGENOMIC</LIBRARY_SOURCE>
      <LIBRARY_SELECTION>RANDOM</LIBRARY_SELECTION>
      <LIBRARY_LAYOUT><PAIRED/></LIBRARY_LAYOUT>
    </LIBRARY_DESCRIPTOR>
  </DESIGN>
  <PLATFORM><ILLUMINA><INSTRUMENT_MODEL>Illumina HiSeq 2500</INSTRUMENT_MODEL></ILLUMINA></PLATFORM>
</EXPERIMENT>
<SUBMISSION accession="SRA1361668" alias="sub-alias" center_name="BioTech Center"/>
<Organization type="institute" url="https://example.org"><Name>BioTech Center</Name></Organization>
<STUDY accession="SRP356657" alias="PRJNA800381" center_name="BioProject">
  <IDENTIFIERS>
    <PRIMARY_ID>SRP356657</PRIMARY_ID>
    <EXTERNAL_ID namespace="BioProject" label="primary">PRJNA800381</EXTERNAL_ID>
  </IDENTIFIERS>
  <DESCRIPTOR>
    <STUDY_TITLE>Gut metagenome study of cohort A</STUDY_TITLE>
    <STUDY_TYPE existing_study_type="Metagenomics"/>
    <STUDY_ABSTRACT>Abstract text.</STUDY_ABSTRACT>
    <CENTER_NAME>BioTech Center</CENTER_NAME>
  </DESCRIPTOR>
</STUDY>
<SAMPLE accession="SRS11761419" alias="sample-1">
  <IDENTIFIERS><PRIMARY_ID>SRS11761419</PRIMARY_ID></IDENTIFIERS>
  <TITLE>Stool sample donor 1</TITLE>
  <SAMPLE_NAME><TAXON_ID>9606</TAXON_ID><SCIENTIFIC_NAME>Homo sapiens</SCIENTIFIC_NAME></SAMPLE_NAME>
</SAMPLE>
<RUN_SET>
  <RUN accession="SRR14432476" alias="run1" total_spots="1159103" total_bases="539703485" size="316987602" load_done="true" published="2021-05-21 10:43:57" is_public="true"/>
  <RUN accession="SRR14432477" alias="run2" total_spots="2200000" total_bases="440000000" size="320000000" published="2021-05-22 11:00:00"/>
</RUN_SET>
</EXPERIMENT_PACKAGE>
<EXPERIMENT_PACKAGE>
<EXPERIMENT accession="SRX13898299" alias="run2 alias">
  <IDENTIFIERS><PRIMARY_ID>SRX13898299</PRIMARY_ID></IDENTIFIERS>
  <TITLE>Gut metagenome experiment 2</TITLE>
  <STUDY_REF accession="SRP356657"><IDENTIFIERS><PRIMARY_ID>SRP356657</PRIMARY_ID></IDENTIFIERS></STUDY_REF>
  <DESIGN>
    <DESIGN_DESCRIPTION>Second experiment</DESIGN_DESCRIPTION>
    <SAMPLE_DESCRIPTOR accession="SRS11761420"><IDENTIFIERS><PRIMARY_ID>SRS11761420</PRIMARY_ID></IDENTIFIERS></SAMPLE_DESCRIPTOR>
    <LIBRARY_DESCRIPTOR>
      <LIBRARY_NAME/>
      <LIBRARY_STRATEGY>AMPLICON</LIBRARY_STRATEGY>
      <LIBRARY_SOURCE>METAGENOMIC</LIBRARY_SOURCE>
      <LIBRARY_SELECTION>PCR</LIBRARY_SELECTION>
      <LIBRARY_LAYOUT><SINGLE/></LIBRARY_LAYOUT>
    </LIBRARY_DESCRIPTOR>
  </DESIGN>
  <PLATFORM><ION_TORRENT><INSTRUMENT_MODEL>Ion Torrent PGM</INSTRUMENT_MODEL></ION_TORRENT></PLATFORM>
</EXPERIMENT>
<SUBMISSION accession="SRA1361668" alias="sub-alias" center_name="BioTech Center"/>
<STUDY accession="SRP356657" alias="PRJNA800381" center_name="BioProject">
  <IDENTIFIERS>
    <PRIMARY_ID>SRP356657</PRIMARY_ID>
    <EXTERNAL_ID namespace="BioProject" label="primary">PRJNA800381</EXTERNAL_ID>
  </IDENTIFIERS>
  <DESCRIPTOR>
    <STUDY_TITLE>Gut metagenome study of cohort A</STUDY_TITLE>
    <STUDY_TYPE existing_study_type="Metagenomics"/>
    <CENTER_NAME>BioTech Center</CENTER_NAME>
  </DESCRIPTOR>
</STUDY>
<SAMPLE accession="SRS11761420" alias="sample-2">
  <IDENTIFIERS><PRIMARY_ID>SRS11761420</PRIMARY_ID></IDENTIFIERS>
  <TITLE>Stool sample donor 2</TITLE>
  <SAMPLE_NAME><TAXON_ID>9606</TAXON_ID><SCIENTIFIC_NAME>Homo sapiens</SCIENTIFIC_NAME></SAMPLE_NAME>
</SAMPLE>
<RUN_SET>
  <RUN accession="SRR14432478" alias="run3" total_spots="50000" total_bases="7500000" size="6000000" published="2021-05-23 08:00:00"/>
</RUN_SET>
</EXPERIMENT_PACKAGE>
</EXPERIMENT_PACKAGE_SET>`;

const SINGLE_EXPERIMENT_XML = `<?xml version="1.0" encoding="UTF-8"  ?>
<EXPERIMENT_PACKAGE_SET>
<EXPERIMENT_PACKAGE>
<EXPERIMENT accession="SRX5000001" alias="nanopore-alias">
  <IDENTIFIERS><PRIMARY_ID>SRX5000001</PRIMARY_ID></IDENTIFIERS>
  <TITLE>Nanopore direct RNA experiment</TITLE>
  <STUDY_REF accession="SRP5000001"><IDENTIFIERS><PRIMARY_ID>SRP5000001</PRIMARY_ID></IDENTIFIERS></STUDY_REF>
  <DESIGN>
    <DESIGN_DESCRIPTION>Direct RNA sequencing</DESIGN_DESCRIPTION>
    <SAMPLE_DESCRIPTOR accession="SRS5000001"><IDENTIFIERS><PRIMARY_ID>SRS5000001</PRIMARY_ID></IDENTIFIERS></SAMPLE_DESCRIPTOR>
    <LIBRARY_DESCRIPTOR>
      <LIBRARY_NAME/>
      <LIBRARY_STRATEGY>RNA-Seq</LIBRARY_STRATEGY>
      <LIBRARY_SOURCE>TRANSCRIPTOMIC</LIBRARY_SOURCE>
      <LIBRARY_SELECTION>cDNA</LIBRARY_SELECTION>
      <LIBRARY_LAYOUT><SINGLE/></LIBRARY_LAYOUT>
    </LIBRARY_DESCRIPTOR>
  </DESIGN>
  <PLATFORM><OXFORD_NANOPORE><INSTRUMENT_MODEL>MinION</INSTRUMENT_MODEL></OXFORD_NANOPORE></PLATFORM>
  <EXPERIMENT_ATTRIBUTES>
    <EXPERIMENT_ATTRIBUTE><TAG>source_name</TAG><VALUE>HeLa cell culture</VALUE></EXPERIMENT_ATTRIBUTE>
    <EXPERIMENT_ATTRIBUTE><TAG>collection_date</TAG><VALUE>2022-03</VALUE></EXPERIMENT_ATTRIBUTE>
  </EXPERIMENT_ATTRIBUTES>
</EXPERIMENT>
<SUBMISSION accession="SRA9999999" alias="sub" center_name="Nanopore Lab"/>
<STUDY accession="SRP5000001" alias="PRJNA9999999" center_name="BioProject">
  <IDENTIFIERS>
    <PRIMARY_ID>SRP5000001</PRIMARY_ID>
    <EXTERNAL_ID namespace="BioProject" label="primary">PRJNA9999999</EXTERNAL_ID>
    <EXTERNAL_ID namespace="DOI">10.1234/foo</EXTERNAL_ID>
  </IDENTIFIERS>
  <DESCRIPTOR>
    <STUDY_TITLE>Direct RNA nanopore study</STUDY_TITLE>
    <STUDY_TYPE existing_study_type="Transcriptome Sequencing"/>
    <CENTER_NAME>Nanopore Lab</CENTER_NAME>
  </DESCRIPTOR>
</STUDY>
<SAMPLE accession="SRS5000001" alias="hela">
  <IDENTIFIERS><PRIMARY_ID>SRS5000001</PRIMARY_ID></IDENTIFIERS>
  <TITLE>HeLa cells</TITLE>
  <SAMPLE_NAME><TAXON_ID>9606</TAXON_ID><SCIENTIFIC_NAME>Homo sapiens</SCIENTIFIC_NAME></SAMPLE_NAME>
  <SAMPLE_ATTRIBUTES>
    <SAMPLE_ATTRIBUTE><TAG>cell_line</TAG><VALUE>HeLa</VALUE></SAMPLE_ATTRIBUTE>
    <SAMPLE_ATTRIBUTE><TAG>tissue</TAG><VALUE>cervix</VALUE></SAMPLE_ATTRIBUTE>
  </SAMPLE_ATTRIBUTES>
</SAMPLE>
<RUN_SET>
  <RUN accession="SRR6000001" alias="np-run" total_spots="250000" total_bases="1800000000" size="1200000000" published="2022-04-01 09:15:00"/>
</RUN_SET>
</EXPERIMENT_PACKAGE>
</EXPERIMENT_PACKAGE_SET>`;

const ERROR_XML = `<?xml version="1.0" encoding="UTF-8"  ?>
<EXPERIMENT_PACKAGE_SET>
<ERROR>SRA Experiment id=999999999 does not exist</ERROR>
</EXPERIMENT_PACKAGE_SET>`;

function okJson(body: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(body),
  };
}

function okXml(xml: string) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'content-type': 'text/xml' }),
    text: () => Promise.resolve(xml),
  };
}

function esearchBody(ids: string[], count?: number) {
  return { esearchresult: { count: String(count ?? ids.length), idlist: ids } };
}

function mockEutils(handlers: {
  esearch?: (url: URL) => unknown;
  efetch?: (url: URL) => string;
}): void {
  global.fetch = jest.fn().mockImplementation((rawUrl: string) => {
    const url = new URL(rawUrl);
    if (url.pathname.endsWith('/esearch.fcgi') && handlers.esearch) {
      const body = handlers.esearch(url);
      return Promise.resolve(okJson(typeof body === 'string' ? JSON.parse(body) : body));
    }
    if (url.pathname.endsWith('/efetch.fcgi') && handlers.efetch) {
      return Promise.resolve(okXml(handlers.efetch(url)));
    }
    return Promise.reject(new Error(`Unexpected fetch in test: ${rawUrl}`));
  }) as unknown as typeof global.fetch;
}

function fetchUrls(): string[] {
  return (global.fetch as unknown as { mock: { calls: string[][] } }).mock.calls.map(
    call => call[0]
  );
}

function efetchCallUrls(): string[] {
  return fetchUrls().filter(url => url.includes('efetch.fcgi'));
}

function efetchIds(url: string): string[] {
  return (new URL(url).searchParams.get('id') || '').split(',').filter(Boolean);
}

describe('parseExperimentPackageSet', () => {
  test('parses an SRP multi-package document into per-experiment records', () => {
    const records = parseExperimentPackageSet(SRP_MULTI_PACKAGE_XML);

    expect(records).toHaveLength(2);
    const first = records[0];
    expect(first.experiment_accession).toBe('SRX13898298');
    expect(first.experiment_title).toBe('Gut metagenome experiment 1');
    expect(first.study_accession).toBe('SRP356657');
    expect(first.study_title).toBe('Gut metagenome study of cohort A');
    expect(first.study_type).toBe('Metagenomics');
    expect(first.bioproject).toBe('PRJNA800381');
    expect(first.sample_accession).toBe('SRS11761419');
    expect(first.sample_title).toBe('Stool sample donor 1');
    expect(first.organism).toBe('Homo sapiens');
    expect(first.taxon_id).toBe('9606');
    expect(first.library).toEqual({
      strategy: 'WGS',
      source: 'METAGENOMIC',
      selection: 'RANDOM',
      layout: 'PAIRED',
    });
    expect(first.platform_vendor).toBe('ILLUMINA');
    expect(first.instrument_model).toBe('Illumina HiSeq 2500');
    expect(first.submission_accession).toBe('SRA1361668');
    expect(first.center_name).toBe('BioTech Center');
    expect(first.experiment_attributes).toBeUndefined();
  });

  test('coerces RUN attribute stats to numbers and keeps run order', () => {
    const records = parseExperimentPackageSet(SRP_MULTI_PACKAGE_XML);

    expect(records[0].run_accessions).toEqual([
      {
        accession: 'SRR14432476',
        total_spots: 1159103,
        total_bases: 539703485,
        size_bytes: 316987602,
        published: '2021-05-21 10:43:57',
      },
      {
        accession: 'SRR14432477',
        total_spots: 2200000,
        total_bases: 440000000,
        size_bytes: 320000000,
        published: '2021-05-22 11:00:00',
      },
    ]);
  });

  test('detects SINGLE layout and a non-ILLUMINA platform vendor', () => {
    const records = parseExperimentPackageSet(SINGLE_EXPERIMENT_XML);

    expect(records).toHaveLength(1);
    const record = records[0];
    expect(record.library.layout).toBe('SINGLE');
    expect(record.library.strategy).toBe('RNA-Seq');
    expect(record.platform_vendor).toBe('OXFORD_NANOPORE');
    expect(record.instrument_model).toBe('MinION');
    expect(record.bioproject).toBe('PRJNA9999999');
  });

  test('maps EXPERIMENT_ATTRIBUTE TAG/VALUE pairs and ignores extra EXTERNAL_ID namespaces', () => {
    const record = parseExperimentPackageSet(SINGLE_EXPERIMENT_XML)[0];

    expect(record.experiment_attributes).toEqual({
      source_name: 'HeLa cell culture',
      collection_date: '2022-03',
    });
  });

  test('second package of a multi-package doc gets its own platform/layout', () => {
    const second = parseExperimentPackageSet(SRP_MULTI_PACKAGE_XML)[1];

    expect(second.experiment_accession).toBe('SRX13898299');
    expect(second.platform_vendor).toBe('ION_TORRENT');
    expect(second.library.layout).toBe('SINGLE');
    expect(second.library.strategy).toBe('AMPLICON');
    expect(second.run_accessions.map(run => run.accession)).toEqual(['SRR14432478']);
  });

  test('throws on EXPERIMENT_PACKAGE_SET ERROR document', () => {
    expect(() => parseExperimentPackageSet(ERROR_XML)).toThrow(
      'SRA Experiment id=999999999 does not exist'
    );
  });

  test('throws on bare Error: text body', () => {
    expect(() => parseExperimentPackageSet('Error: Failed to understand Id=abc')).toThrow(
      /Failed to understand Id/
    );
  });

  test('throws Malformed on non-XML and missing-root documents', () => {
    expect(() => parseExperimentPackageSet('<not-xml><![CDATA[')).toThrow(/Malformed/);
    expect(() => parseExperimentPackageSet('<WRONG_ROOT/>')).toThrow(/Malformed/);
  });

  test('throws Malformed on a package without an EXPERIMENT accession', () => {
    const doc = `<?xml version="1.0"?>
<EXPERIMENT_PACKAGE_SET><EXPERIMENT_PACKAGE><TITLE>no experiment</TITLE></EXPERIMENT_PACKAGE></EXPERIMENT_PACKAGE_SET>`;
    expect(() => parseExperimentPackageSet(doc)).toThrow(/Malformed.*package 0/);
  });
});

describe('sraSearch', () => {
  let originalFetch: typeof global.fetch;
  let envBackup: Record<string, string | undefined>;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    envBackup = {
      NCBI_API_KEY: process.env.NCBI_API_KEY,
      NCBI_EMAIL: process.env.NCBI_EMAIL,
    };
    delete process.env.NCBI_API_KEY;
    delete process.env.NCBI_EMAIL;
    connectionManager.closeAll();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    connectionManager.closeAll();
  });

  test('batches efetch 10 ids per request and preserves esearch idlist order', async () => {
    const uidToExperiment: Record<string, string> = {};
    for (let i = 0; i < 12; i++) {
      uidToExperiment[String(19386400 + i)] = `SRX1389800${i}`;
    }
    const ids = Object.keys(uidToExperiment);

    mockEutils({
      esearch: url => {
        expect(url.searchParams.get('db')).toBe('sra');
        expect(url.searchParams.get('retmode')).toBe('json');
        return esearchBody(ids);
      },
      efetch: url => {
        const requested = efetchIds(url);
        expect(requested.length).toBeLessThanOrEqual(10);
        const packages = requested.map(uid => packageXml({ experiment: uidToExperiment[uid] }));
        return `<?xml version="1.0"?>\n<EXPERIMENT_PACKAGE_SET>${packages.join('')}</EXPERIMENT_PACKAGE_SET>`;
      },
    });

    const results = await sraSearch('SRP356657', { limit: 12 });

    expect(results).toHaveLength(12);
    expect(results.map(item => item.experiment_accession)).toEqual(ids.map(uid => uidToExperiment[uid]));

    const efetchUrls = efetchCallUrls();
    expect(efetchUrls).toHaveLength(2);
    expect(efetchIds(efetchUrls[0])).toEqual(ids.slice(0, 10));
    expect(efetchIds(efetchUrls[1])).toEqual(ids.slice(10));

    expect(results[0]).toMatchObject({
      study_accession: 'SRP356657',
      sample_accession: 'SRS11761419',
      organism: 'Homo sapiens',
      library_strategy: 'WGS',
      run_count: 1,
      first_run_accession: 'SRR14432476',
      bioproject: 'PRJNA800381',
    });
  });

  test('caps retmax at 50 and applies offset', async () => {
    mockEutils({
      esearch: url => {
        expect(url.searchParams.get('retmax')).toBe('50');
        expect(url.searchParams.get('retstart')).toBe('20');
        return esearchBody([]);
      },
    });

    const results = await sraSearch('lib_strategy[WGS] AND organism', { limit: 100, offset: 20 });
    expect(results).toEqual([]);
    expect(fetchUrls().filter(url => url.includes('efetch.fcgi'))).toHaveLength(0);
  });

  test('propagates esearch application errors (HTTP 200)', async () => {
    mockEutils({
      esearch: () => ({ esearchresult: { error: 'Query disabled' } }),
    });

    await expect(sraSearch('SRP1')).rejects.toThrow(/SRA search: E-utilities error: Query disabled/);
  });
});

describe('sraGet', () => {
  let originalFetch: typeof global.fetch;
  let envBackup: Record<string, string | undefined>;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    envBackup = {
      NCBI_API_KEY: process.env.NCBI_API_KEY,
      NCBI_EMAIL: process.env.NCBI_EMAIL,
    };
    delete process.env.NCBI_API_KEY;
    delete process.env.NCBI_EMAIL;
    connectionManager.closeAll();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    connectionManager.closeAll();
  });

  test('SRX accession returns a full experiment detail', async () => {
    mockEutils({
      esearch: url => {
        expect(url.searchParams.get('db')).toBe('sra');
        expect(url.searchParams.get('term')).toBe('SRX13898298');
        return esearchBody(['19386492']);
      },
      efetch: () => SRP_MULTI_PACKAGE_XML,
    });

    const detail = await sraGet('SRX13898298');

    expect(detail.entry_type).toBe('experiment');
    if (detail.entry_type !== 'experiment') return;
    expect(detail.accession).toBe('SRX13898298');
    expect(detail.experiment_accession).toBe('SRX13898298');
    expect(detail.library.layout).toBe('PAIRED');
    expect(detail.platform_vendor).toBe('ILLUMINA');
    expect(detail.run_accessions).toHaveLength(2);
    expect(detail.bioproject).toBe('PRJNA800381');
    expect(efetchIds(efetchCallUrls()[0])).toEqual(['19386492']);
  });

  test('SRR accession returns a run-focused detail with stats', async () => {
    mockEutils({
      esearch: () => esearchBody(['19386492']),
      efetch: () => SRP_MULTI_PACKAGE_XML,
    });

    const detail = await sraGet('SRR14432477');

    expect(detail.entry_type).toBe('run');
    if (detail.entry_type !== 'run') return;
    expect(detail.accession).toBe('SRR14432477');
    expect(detail.experiment_accession).toBe('SRX13898298');
    expect(detail.study_accession).toBe('SRP356657');
    expect(detail.sample_accession).toBe('SRS11761419');
    expect(detail.organism).toBe('Homo sapiens');
    expect(detail.platform_vendor).toBe('ILLUMINA');
    expect(detail.instrument_model).toBe('Illumina HiSeq 2500');
    expect(detail.total_spots).toBe(2200000);
    expect(detail.total_bases).toBe(440000000);
    expect(detail.size_bytes).toBe(320000000);
    expect(detail.published).toBe('2021-05-22 11:00:00');
    expect(detail.bioproject).toBe('PRJNA800381');
  });

  test('SRR accession not present in fetched packages throws not-found', async () => {
    mockEutils({
      esearch: () => esearchBody(['19386492']),
      efetch: () => SRP_MULTI_PACKAGE_XML,
    });

    await expect(sraGet('SRR99999999')).rejects.toThrow(/SRR99999999.*not found/);
  });

  test('SRP accession returns a study detail with capped experiment summaries', async () => {
    const uids = ['19386492', '19386493', '19386494'];
    mockEutils({
      esearch: () => esearchBody(uids, 120),
      efetch: url => {
        expect(efetchIds(url)).toEqual(uids);
        const extra = efetchIds(url)
          .slice(2)
          .map(uid => packageXml({ experiment: `SRX-EXTRA-${uid}` }));
        return SRP_MULTI_PACKAGE_XML.replace('</EXPERIMENT_PACKAGE_SET>', `${extra.join('')}</EXPERIMENT_PACKAGE_SET>`);
      },
    });

    const detail = await sraGet('SRP356657');

    expect(detail.entry_type).toBe('study');
    if (detail.entry_type !== 'study') return;
    expect(detail.accession).toBe('SRP356657');
    expect(detail.study_title).toBe('Gut metagenome study of cohort A');
    expect(detail.study_type).toBe('Metagenomics');
    expect(detail.bioproject).toBe('PRJNA800381');
    expect(detail.center_name).toBe('BioTech Center');
    expect(detail.submission_accession).toBe('SRA1361668');
    expect(detail.total_experiments).toBe(120);
    expect(detail.experiments).toHaveLength(3);
    expect(detail.experiments[0]).toEqual({
      experiment_accession: 'SRX13898298',
      sample_accession: 'SRS11761419',
      organism: 'Homo sapiens',
      library_strategy: 'WGS',
      runs: ['SRR14432476', 'SRR14432477'],
    });
  });

  test('SRS accession returns a sample detail from matching packages', async () => {
    mockEutils({
      esearch: url => {
        expect(url.searchParams.get('term')).toBe('SRS11761419');
        return esearchBody(['19386492', '19386493'], 2);
      },
      efetch: () => SRP_MULTI_PACKAGE_XML,
    });

    const detail = await sraGet('SRS11761419');

    expect(detail.entry_type).toBe('sample');
    if (detail.entry_type !== 'sample') return;
    expect(detail.accession).toBe('SRS11761419');
    expect(detail.organism).toBe('Homo sapiens');
    expect(detail.taxon_id).toBe('9606');
    expect(detail.sample_title).toBe('Stool sample donor 1');
    expect(detail.total_experiments).toBe(2);
    // Only the package whose SAMPLE matches SRS11761419 is listed.
    expect(detail.experiments).toHaveLength(1);
    expect(detail.experiments[0].experiment_accession).toBe('SRX13898298');
    expect(detail.experiments[0].runs).toEqual(['SRR14432476', 'SRR14432477']);
  });

  test('ERP accession with empty idlist rejects with ENA hint', async () => {
    mockEutils({
      esearch: url => {
        expect(url.searchParams.get('term')).toBe('ERP013000');
        return esearchBody([]);
      },
    });

    await expect(sraGet('ERP013000')).rejects.toThrow(/ERP013000 not found/);
    await expect(sraGet('ERP013000')).rejects.toThrow(/https:\/\/www.ebi.ac.uk\/ena/);
  });

  test('efetch ERROR document (HTTP 200) rejects', async () => {
    mockEutils({
      esearch: () => esearchBody(['999999999']),
      efetch: () => ERROR_XML,
    });

    await expect(sraGet('SRX00000000')).rejects.toThrow(/SRA Experiment id=999999999 does not exist/);
  });
});

interface PackageSpec {
  experiment: string;
  study?: string;
  sample?: string;
  organism?: string;
  runs?: string[];
}

function packageXml(spec: PackageSpec): string {
  const study = spec.study ?? 'SRP356657';
  const sample = spec.sample ?? 'SRS11761419';
  const runs = (spec.runs ?? ['SRR14432476'])
    .map(
      accession =>
        `<RUN accession="${accession}" total_spots="1159103" total_bases="539703485" size="316987602" published="2021-05-21 10:43:57"/>`
    )
    .join('');
  return `<EXPERIMENT_PACKAGE><EXPERIMENT accession="${spec.experiment}" alias="alias">
<IDENTIFIERS><PRIMARY_ID>${spec.experiment}</PRIMARY_ID></IDENTIFIERS>
<TITLE>Experiment ${spec.experiment}</TITLE>
<STUDY_REF accession="${study}"><IDENTIFIERS><PRIMARY_ID>${study}</PRIMARY_ID></IDENTIFIERS></STUDY_REF>
<DESIGN><SAMPLE_DESCRIPTOR accession="${sample}"><IDENTIFIERS><PRIMARY_ID>${sample}</PRIMARY_ID></IDENTIFIERS></SAMPLE_DESCRIPTOR>
<LIBRARY_DESCRIPTOR><LIBRARY_NAME/><LIBRARY_STRATEGY>WGS</LIBRARY_STRATEGY><LIBRARY_SOURCE>METAGENOMIC</LIBRARY_SOURCE><LIBRARY_SELECTION>RANDOM</LIBRARY_SELECTION><LIBRARY_LAYOUT><PAIRED/></LIBRARY_LAYOUT></LIBRARY_DESCRIPTOR></DESIGN>
<PLATFORM><ILLUMINA><INSTRUMENT_MODEL>Illumina HiSeq 2500</INSTRUMENT_MODEL></ILLUMINA></PLATFORM>
</EXPERIMENT>
<SUBMISSION accession="SRA1361668" alias="sub" center_name="BioTech Center"/>
<STUDY accession="${study}" alias="PRJNA800381" center_name="BioProject"><IDENTIFIERS><PRIMARY_ID>${study}</PRIMARY_ID><EXTERNAL_ID namespace="BioProject" label="primary">PRJNA800381</EXTERNAL_ID></IDENTIFIERS><DESCRIPTOR><STUDY_TITLE>Test study</STUDY_TITLE><STUDY_TYPE existing_study_type="Metagenomics"/><CENTER_NAME>BioTech Center</CENTER_NAME></DESCRIPTOR></STUDY>
<SAMPLE accession="${sample}" alias="s"><IDENTIFIERS><PRIMARY_ID>${sample}</PRIMARY_ID></IDENTIFIERS><TITLE>Sample ${sample}</TITLE><SAMPLE_NAME><TAXON_ID>9606</TAXON_ID><SCIENTIFIC_NAME>${spec.organism ?? 'Homo sapiens'}</SCIENTIFIC_NAME></SAMPLE_NAME></SAMPLE>
<RUN_SET>${runs}</RUN_SET>
</EXPERIMENT_PACKAGE>`;
}
