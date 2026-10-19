import { jest, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import { connectionManager } from '../../connections/manager.js';
import { createMcpTestHarness, type McpTestHarness } from '../helpers/mcp-harness.js';
import { mockGlobalFetch } from '../helpers/mock-fetch.js';

const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';

const MULTI_PACKAGE_XML = `<?xml version="1.0" encoding="UTF-8"  ?>
<EXPERIMENT_PACKAGE_SET>
<EXPERIMENT_PACKAGE>
<EXPERIMENT accession="SRX13898298" alias="run1 alias">
  <IDENTIFIERS><PRIMARY_ID>SRX13898298</PRIMARY_ID></IDENTIFIERS>
  <TITLE>Gut metagenome experiment 1</TITLE>
  <STUDY_REF accession="SRP356657"><IDENTIFIERS><PRIMARY_ID>SRP356657</PRIMARY_ID></IDENTIFIERS></STUDY_REF>
  <DESIGN>
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
<SAMPLE accession="SRS11761419" alias="sample-1">
  <IDENTIFIERS><PRIMARY_ID>SRS11761419</PRIMARY_ID></IDENTIFIERS>
  <SAMPLE_NAME><TAXON_ID>9606</TAXON_ID><SCIENTIFIC_NAME>Homo sapiens</SCIENTIFIC_NAME></SAMPLE_NAME>
</SAMPLE>
<RUN_SET>
  <RUN accession="SRR14432476" alias="run1" total_spots="1159103" total_bases="539703485" size="316987602" published="2021-05-21 10:43:57"/>
  <RUN accession="SRR14432477" alias="run2" total_spots="2200000" total_bases="440000000" size="320000000" published="2021-05-22 11:00:00"/>
</RUN_SET>
</EXPERIMENT_PACKAGE>
<EXPERIMENT_PACKAGE>
<EXPERIMENT accession="SRX13898299" alias="run2 alias">
  <IDENTIFIERS><PRIMARY_ID>SRX13898299</PRIMARY_ID></IDENTIFIERS>
  <TITLE>Gut metagenome experiment 2</TITLE>
  <STUDY_REF accession="SRP356657"><IDENTIFIERS><PRIMARY_ID>SRP356657</PRIMARY_ID></IDENTIFIERS></STUDY_REF>
  <DESIGN>
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
  <IDENTIFIERS><PRIMARY_ID>SRP356657</PRIMARY_ID></IDENTIFIERS>
  <DESCRIPTOR><STUDY_TITLE>Gut metagenome study of cohort A</STUDY_TITLE></DESCRIPTOR>
</STUDY>
<SAMPLE accession="SRS11761420" alias="sample-2">
  <IDENTIFIERS><PRIMARY_ID>SRS11761420</PRIMARY_ID></IDENTIFIERS>
  <SAMPLE_NAME><TAXON_ID>9606</TAXON_ID><SCIENTIFIC_NAME>Homo sapiens</SCIENTIFIC_NAME></SAMPLE_NAME>
</SAMPLE>
<RUN_SET>
  <RUN accession="SRR14432478" alias="run3" total_spots="50000" total_bases="7500000" size="6000000" published="2021-05-23 08:00:00"/>
</RUN_SET>
</EXPERIMENT_PACKAGE>
</EXPERIMENT_PACKAGE_SET>`;

const DDBJ_PACKAGE_XML = `<?xml version="1.0" encoding="UTF-8"  ?>
<EXPERIMENT_PACKAGE_SET>
<EXPERIMENT_PACKAGE>
<EXPERIMENT accession="DRX579758" alias="ddbj alias">
  <IDENTIFIERS><PRIMARY_ID>DRX579758</PRIMARY_ID></IDENTIFIERS>
  <TITLE>DDBJ metagenome experiment</TITLE>
  <STUDY_REF accession="DRP021325"><IDENTIFIERS><PRIMARY_ID>DRP021325</PRIMARY_ID></IDENTIFIERS></STUDY_REF>
  <DESIGN>
    <SAMPLE_DESCRIPTOR accession="DRS0246071"><IDENTIFIERS><PRIMARY_ID>DRS0246071</PRIMARY_ID></IDENTIFIERS></SAMPLE_DESCRIPTOR>
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
<SUBMISSION accession="DRA008476" alias="sub" center_name="DDBJ Center"/>
<STUDY accession="DRP021325" alias="PRJDB…" center_name="DDBJ Center">
  <IDENTIFIERS><PRIMARY_ID>DRP021325</PRIMARY_ID></IDENTIFIERS>
  <DESCRIPTOR>
    <STUDY_TITLE>DDBJ gut metagenome study</STUDY_TITLE>
    <STUDY_TYPE existing_study_type="Metagenomics"/>
    <CENTER_NAME>DDBJ Center</CENTER_NAME>
  </DESCRIPTOR>
</STUDY>
<SAMPLE accession="DRS0246071" alias="sample-ddbj">
  <IDENTIFIERS><PRIMARY_ID>DRS0246071</PRIMARY_ID></IDENTIFIERS>
  <SAMPLE_NAME><TAXON_ID>9606</TAXON_ID><SCIENTIFIC_NAME>Homo sapiens</SCIENTIFIC_NAME></SAMPLE_NAME>
</SAMPLE>
<RUN_SET>
  <RUN accession="DRR599211" alias="run-ddbj" total_spots="1000" total_bases="200000" size="100000" published="2020-01-15 00:00:00"/>
  <RUN accession="ERR174237" alias="run-ena" total_spots="2000" total_bases="400000" size="200000" published="2013-06-06 00:00:00"/>
</RUN_SET>
</EXPERIMENT_PACKAGE>
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

function mockEutils(esearchIds: string[], efetchXml: string = MULTI_PACKAGE_XML): void {
  global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation((rawUrl: string) => {
    const url = new URL(rawUrl);
    if (url.pathname.endsWith('/esearch.fcgi')) {
      return Promise.resolve(okJson({ esearchresult: { count: String(esearchIds.length), idlist: esearchIds } }));
    }
    if (url.pathname.endsWith('/efetch.fcgi')) {
      return Promise.resolve(okXml(efetchXml));
    }
    return Promise.reject(new Error(`Unexpected fetch in test: ${rawUrl}`));
  }) as unknown as typeof global.fetch;
}

function fetchUrls(): string[] {
  return (global.fetch as unknown as { mock: { calls: string[][] } }).mock.calls.map(call => call[0]);
}

describe('sra tools', () => {
  let harness: McpTestHarness;
  mockGlobalFetch();

  beforeAll(async () => {
    harness = await createMcpTestHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    connectionManager.closeAll();
  });

  it('sra_search returns per-experiment items with run stats', async () => {
    mockEutils(['8877661', '8877662']);

    const results = (await harness.callTool('sra_search', { query: 'RNA-SEQ AND Homo sapiens[Organism]' })) as any[];

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      experiment_accession: 'SRX13898298',
      study_accession: 'SRP356657',
      sample_accession: 'SRS11761419',
      organism: 'Homo sapiens',
      library_strategy: 'WGS',
      run_count: 2,
      first_run_accession: 'SRR14432476',
    });
  });

  it('sra_get returns run-level detail for an SRR accession', async () => {
    mockEutils(['8877661']);

    const detail = (await harness.callTool('sra_get', { accession: 'SRR14432476' })) as any;

    expect(detail).toMatchObject({
      entry_type: 'run',
      accession: 'SRR14432476',
      experiment_accession: 'SRX13898298',
      study_accession: 'SRP356657',
      total_spots: 1159103,
      total_bases: 539703485,
      instrument_model: 'Illumina HiSeq 2500',
    });
  });

  it('sra_get resolves DDBJ (DRX) and European (ERR) accessions via NCBI', async () => {
    mockEutils(['8877661'], DDBJ_PACKAGE_XML);

    const experiment = (await harness.callTool('sra_get', { accession: 'DRX579758' })) as any;
    expect(experiment.entry_type).toBe('experiment');
    expect(experiment.accession).toBe('DRX579758');
    expect(experiment.study_accession).toBe('DRP021325');

    const run = (await harness.callTool('sra_get', { accession: 'ERR174237' })) as any;
    expect(run.entry_type).toBe('run');
    expect(run.accession).toBe('ERR174237');
    expect(run.experiment_accession).toBe('DRX579758');
  });

  it('sra_get rejects malformed accessions with the expected-format error', async () => {
    mockEutils(['8877661']);

    // Rejected at the SCHEMA level (issue #163) — the shape message names
    // the expected form and no fetch happens.
    await expect(harness.callTool('sra_get', { accession: 'ABC123' })).rejects.toThrow(
      /SRA accession must be like SRR14432476/
    );
    expect(fetchUrls()).toHaveLength(0);
  });

  it('sra_get rejects garbage and prefix-less accessions before hitting NCBI', async () => {
    mockEutils(['8877661']);

    for (const bad of ['banana', 'XRQ12345', 'SRR', 'SRR14432476!']) {
      await expect(harness.callTool('sra_get', { accession: bad })).rejects.toThrow(
        /SRA accession must be like SRR14432476/
      );
    }
    expect(fetchUrls()).toHaveLength(0);
  });
});
