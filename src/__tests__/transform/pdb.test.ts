import { transformPdbEntry } from '../../transform/pdb.js';

describe('transformPdbEntry', () => {
  it('maps full entry correctly', () => {
    const raw = {
      struct: { title: 'THE STRUCTURE OF CRAMBIN' },
      exptl: [{ method: 'X-RAY DIFFRACTION' }],
      refine: [{ ls_d_res_high: 0.83 }],
      rcsb_entry_info: {
        molecular_weight: 4711,
        polymer_entity_count: 1,
        polymer_composition: 'protein',
      },
      rcsb_accession_info: {
        initial_release_date: '1981-09-09',
        deposit_date: '1981-04-13',
      },
      rcsb_entry_container_identifiers: {
        polymer_entity_ids: ['1'],
        non_polymer_entity_ids: [],
        assembly_ids: ['1'],
      },
      rcsb_primary_citation: {
        title: 'Crystal structure of crambin',
        pdbx_database_id_DOI: '10.2210/pdb1crn/pdb',
        pdbx_database_id_PubMed: '7206452',
        authors: [{ name: 'Hendrickson, W.A.' }, { name: 'Teeter, M.M.' }],
        journal_abbrev: 'Acta Crystallogr.',
        year: 1981,
      },
      audit_author: [{ name: 'Hendrickson, W.A.' }, { name: 'Teeter, M.M.' }],
      rcsb_entity_source_organism: [{
        ncbi_scientific_name: 'Crambe hispanica',
        common_name: 'crambe',
      }],
      symmetry: { space_group_name_H_M: 'P 21 21 21' },
      cell: {
        length_a: 40.96,
        length_b: 18.55,
        length_c: 22.52,
        angle_alpha: 90,
        angle_beta: 90,
        angle_gamma: 90,
      },
    };

    const result = transformPdbEntry('1CRN', raw as any);
    expect(result).toEqual({
      pdb_id: '1CRN',
      title: 'THE STRUCTURE OF CRAMBIN',
      experimental_method: 'X-RAY DIFFRACTION',
      resolution: 0.83,
      molecular_weight: 4711,
      polymer_count: 1,
      polymer_composition: 'protein',
      deposition_date: '1981-04-13',
      release_date: '1981-09-09',
      organism: 'Crambe hispanica',
      doi: '10.2210/pdb1crn/pdb',
      pmid: '7206452',
      authors: ['Hendrickson, W.A.', 'Teeter, M.M.'],
      space_group: 'P 21 21 21',
      unit_cell: {
        a: 40.96, b: 18.55, c: 22.52,
        alpha: 90, beta: 90, gamma: 90,
      },
      container_ids: {
        polymer_entity_ids: ['1'],
        non_polymer_entity_ids: [],
        assembly_ids: ['1'],
      },
    });
  });

  it('handles missing optional fields gracefully', () => {
    const raw = {
      struct: { title: 'MINIMAL ENTRY' },
    };

    const result = transformPdbEntry('XXXX', raw as any);
    expect(result.pdb_id).toBe('XXXX');
    expect(result.title).toBe('MINIMAL ENTRY');
    expect(result.experimental_method).toBeUndefined();
    expect(result.resolution).toBeUndefined();
    expect(result.organism).toBeUndefined();
    expect(result.container_ids).toBeUndefined();
  });

  it('deduplicates experimental methods', () => {
    const raw = {
      struct: { title: 'TEST' },
      exptl: [
        { method: 'X-RAY DIFFRACTION' },
        { method: 'X-RAY DIFFRACTION' },
        { method: 'ELECTRON MICROSCOPY' },
      ],
    };

    const result = transformPdbEntry('TEST', raw as any);
    expect(result.experimental_method).toBe('X-RAY DIFFRACTION, ELECTRON MICROSCOPY');
  });
});
