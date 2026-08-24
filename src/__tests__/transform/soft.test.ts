import {
  parseSoftRecord,
  getSoftValue,
  getSoftValues,
} from '../../transform/soft.js';

const GSE_SOFT = [
  '^SERIES = GSE183947',
  '!Series_title = Identification of five cytotoxicity-related genes',
  '!Series_geo_accession = GSE183947',
  '!Series_status = Public on Sep 15 2021',
  '!Series_type = Expression profiling by high throughput sequencing',
  '!Series_platform_id = GPL11154',
  '!Series_contributor = Yan,,Zhang',
  '!Series_contributor = Alice,B,Smith',
  '!Series_sample_id = GSM5574685',
  '!Series_sample_id = GSM5574686',
  '!Series_supplementary_file = ftp://ftp.ncbi.nlm.nih.gov/geo/series/GSE183nnn/GSE183947/suppl/GSE183947_fpkm.csv.gz',
  '!Series_relation = BioProject: https://www.ncbi.nlm.nih.gov/bioproject/PRJNA762469',
  '!Series_relation = SRA: https://www.ncbi.nlm.nih.gov/sra?term=SRP336638',
  '!Series_relation = SuperSeries of GSE12345',
  '!Series_summary =',
  '',
].join('\n');

describe('parseSoftRecord', () => {
  test('parses entity header and accession', () => {
    const record = parseSoftRecord(GSE_SOFT);
    expect(record.entity_type).toBe('SERIES');
    expect(record.accession).toBe('GSE183947');
  });

  test('single-value keys are readable via getSoftValue/getSingle', () => {
    const record = parseSoftRecord(GSE_SOFT);
    expect(getSoftValue(record, 'Series_title')).toBe('Identification of five cytotoxicity-related genes');
    expect(record.getSingle('Series_platform_id')).toBe('GPL11154');
    expect(getSoftValue(record, 'Series_missing')).toBeUndefined();
  });

  test('multi-value keys aggregate in file order', () => {
    const record = parseSoftRecord(GSE_SOFT);
    expect(getSoftValues(record, 'Series_sample_id')).toEqual(['GSM5574685', 'GSM5574686']);
    expect(getSoftValues(record, 'Series_contributor')).toEqual(['Yan,,Zhang', 'Alice,B,Smith']);
    expect(getSoftValues(record, 'Series_relation')).toHaveLength(3);
    expect(getSoftValues(record, 'Series_missing')).toEqual([]);
  });

  test('empty values are preserved as empty strings', () => {
    const record = parseSoftRecord(GSE_SOFT);
    expect(getSoftValue(record, 'Series_summary')).toBe('');
  });

  test('tolerates CRLF line endings', () => {
    const record = parseSoftRecord(GSE_SOFT.replace(/\n/g, '\r\n'));
    expect(record.accession).toBe('GSE183947');
    expect(getSoftValues(record, 'Series_sample_id')).toEqual(['GSM5574685', 'GSM5574686']);
  });

  test('continuation lines (leading whitespace) append to the previous value', () => {
    const text = [
      '^SERIES = GSE1',
      '!Series_summary = a very long summary value that',
      ' wraps onto a second line',
      '!Series_title = after a continued value',
    ].join('\n');
    const record = parseSoftRecord(text);
    expect(getSoftValue(record, 'Series_summary')).toBe('a very long summary value thatwraps onto a second line');
    expect(getSoftValue(record, 'Series_title')).toBe('after a continued value');
  });

  test('skips ^^ and ^! sub-entity lines and lines without "="', () => {
    const text = [
      '^SAMPLE = GSM1',
      '^^sub-entities are not emitted with targ=self',
      '^!sub-entities either',
      '!Sample_title = real title',
      '!Sample_weird_line_without_equals',
      '!Sample_source_name_ch1 = tumor',
    ].join('\n');
    const record = parseSoftRecord(text);
    expect(record.entity_type).toBe('SAMPLE');
    expect(record.accession).toBe('GSM1');
    expect(record.fields.size).toBe(2);
    expect(getSoftValue(record, 'Sample_title')).toBe('real title');
  });

  test('parses ^PLATFORM entity type', () => {
    const text = [
      '^PLATFORM = GPL11154',
      '!Platform_title = Illumina HiSeq 2500',
      '!Platform_technology = high-throughput sequencing',
    ].join('\n');
    const record = parseSoftRecord(text);
    expect(record.entity_type).toBe('PLATFORM');
    expect(record.accession).toBe('GPL11154');
    expect(getSoftValue(record, 'Platform_title')).toBe('Illumina HiSeq 2500');
  });

  test('ignores fields after a second ^ENTITY header', () => {
    const text = [
      '^SERIES = GSE1',
      '!Series_title = first record',
      '^SERIES = GSE2',
      '!Series_title = second record must not leak',
    ].join('\n');
    const record = parseSoftRecord(text);
    expect(record.accession).toBe('GSE1');
    expect(getSoftValue(record, 'Series_title')).toBe('first record');
  });

  test('empty input yields an empty record without throwing', () => {
    const record = parseSoftRecord('');
    expect(record.entity_type).toBe('');
    expect(record.accession).toBe('');
    expect(record.fields.size).toBe(0);
  });
});
