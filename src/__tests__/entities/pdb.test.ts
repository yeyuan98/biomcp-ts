import { jest } from '@jest/globals';
import { validatePdbId, formatFileSize, pdbSearch, pdbGet, pdbDownload } from '../../entities/pdb.js';
import { connectionManager } from '../../connections/manager.js';
import { existsSync, unlinkSync, rmSync } from 'node:fs';

// Helper to create a mock connection object
function createMockConnection(methods: Record<string, any> = {}) {
  return {
    sourceId: 'mock',
    protocol: 'rest' as const,
    effectiveRateLimitMs: 100,
    request: methods.request || jest.fn().mockResolvedValue(null),
    post: methods.post || jest.fn().mockResolvedValue(null),
    healthCheck: methods.healthCheck || jest.fn().mockResolvedValue(true),
    close: methods.close || jest.fn(),
  };
}

describe('validatePdbId', () => {
  it('accepts valid 4-char PDB IDs', () => {
    expect(() => validatePdbId('1CRN')).not.toThrow();
    expect(() => validatePdbId('4HHB')).not.toThrow();
    expect(() => validatePdbId('abcd')).not.toThrow();
  });

  it('rejects CSM/AlphaFold IDs', () => {
    expect(() => validatePdbId('AF_AFP68871F1')).toThrow('Computed structure models');
    expect(() => validatePdbId('MA_12345')).toThrow('Computed structure models');
  });

  it('rejects invalid lengths', () => {
    expect(() => validatePdbId('1CR')).toThrow('Invalid PDB ID');
    expect(() => validatePdbId('1CRNNN')).toThrow('Invalid PDB ID');
    expect(() => validatePdbId('')).toThrow('Invalid PDB ID');
  });

  it('rejects special characters', () => {
    expect(() => validatePdbId('1CR-')).toThrow('Invalid PDB ID');
    expect(() => validatePdbId('1CR_')).toThrow('Invalid PDB ID');
  });
});

describe('formatFileSize', () => {
  it('formats bytes', () => {
    expect(formatFileSize(500)).toBe('500 B');
  });

  it('formats kilobytes', () => {
    expect(formatFileSize(1536)).toBe('1.5 KB');
  });

  it('formats megabytes', () => {
    expect(formatFileSize(2_500_000)).toBe('2.4 MB');
  });
});

// ========== NEW TESTS ==========

describe('validatePdbId edge cases', () => {
  it('rejects single character ID', () => {
    expect(() => validatePdbId('A')).toThrow('Invalid PDB ID');
  });

  it('rejects 5 character ID', () => {
    expect(() => validatePdbId('ABCDE')).toThrow('Invalid PDB ID');
  });

  it('rejects numbers-only ID with wrong length', () => {
    expect(() => validatePdbId('123')).toThrow('Invalid PDB ID');
  });

  it('accepts mixed case ID', () => {
    expect(() => validatePdbId('1aB2')).not.toThrow();
  });
});

describe('formatFileSize boundary values', () => {
  it('formats exactly 1024 bytes as KB', () => {
    expect(formatFileSize(1024)).toBe('1.0 KB');
  });

  it('formats exactly 1 MB', () => {
    expect(formatFileSize(1024 * 1024)).toBe('1.0 MB');
  });

  it('formats 0 bytes', () => {
    expect(formatFileSize(0)).toBe('0 B');
  });
});

describe('pdbSearch', () => {
  let originalFetch: typeof global.fetch;
  let mockPost: jest.Mock;
  let mockRequest: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    connectionManager.closeAll();
    mockPost = jest.fn();
    mockRequest = jest.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    connectionManager.closeAll();
  });

  it('calls pdb_search connection with POST and correct body', async () => {
    mockPost.mockResolvedValue({ result_set: [], total_count: 0 });

    // Intercept getConnection to return our mock for pdb_search
    const origGetConnection = connectionManager.getConnection.bind(connectionManager);
    const spy = jest.spyOn(connectionManager, 'getConnection').mockImplementation((sourceId: string) => {
      if (sourceId === 'pdb_search') {
        const conn = createMockConnection({ post: mockPost });
        return conn as any;
      }
      return origGetConnection(sourceId);
    });

    const results = await pdbSearch('hemoglobin');

    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockPost).toHaveBeenCalledWith('/query', expect.objectContaining({
      query: expect.objectContaining({
        type: 'terminal',
        service: 'full_text',
        parameters: { value: 'hemoglobin' },
      }),
      return_type: 'entry',
    }));
    expect(results).toEqual([]);

    spy.mockRestore();
  });

  it('returns empty array for no results', async () => {
    mockPost.mockResolvedValue({ result_set: [], total_count: 0 });

    const spy = jest.spyOn(connectionManager, 'getConnection').mockImplementation((sourceId: string) => {
      if (sourceId === 'pdb_search') {
        return createMockConnection({ post: mockPost }) as any;
      }
      return createMockConnection() as any;
    });

    const results = await pdbSearch('nonexistent_xyz');
    expect(results).toEqual([]);

    spy.mockRestore();
  });

  it('fetches summaries for search results', async () => {
    mockPost.mockResolvedValue({
      result_set: [{ identifier: '4HHB', score: 10.5 }],
      total_count: 1,
    });

    const entryData = {
      struct: { title: 'HEMOGLOBIN' },
      rcsb_entry_container_identifiers: {
        polymer_entity_ids: ['1'],
        non_polymer_entity_ids: [],
        assembly_ids: ['1'],
      },
    };

    let pdbDataCalled = false;
    const spy = jest.spyOn(connectionManager, 'getConnection').mockImplementation((sourceId: string) => {
      if (sourceId === 'pdb_search') {
        return createMockConnection({ post: mockPost }) as any;
      }
      if (sourceId === 'pdb_data') {
        pdbDataCalled = true;
        return createMockConnection({
          request: jest.fn().mockResolvedValue(entryData),
        }) as any;
      }
      return createMockConnection() as any;
    });

    const results = await pdbSearch('hemoglobin');

    expect(results).toHaveLength(1);
    expect(results[0].pdb_id).toBe('4HHB');
    expect(results[0].score).toBe(10.5);
    expect(results[0].summary).toBeDefined();
    expect(results[0].summary!.title).toBe('HEMOGLOBIN');
    expect(pdbDataCalled).toBe(true);

    spy.mockRestore();
  });

  it('passes limit and offset as paginate params', async () => {
    mockPost.mockResolvedValue({ result_set: [], total_count: 0 });

    const spy = jest.spyOn(connectionManager, 'getConnection').mockImplementation((sourceId: string) => {
      if (sourceId === 'pdb_search') {
        return createMockConnection({ post: mockPost }) as any;
      }
      return createMockConnection() as any;
    });

    await pdbSearch('kinase', { limit: 5, offset: 10 });

    expect(mockPost).toHaveBeenCalledWith('/query', expect.objectContaining({
      request_options: {
        paginate: { start: 10, rows: 5 },
        results_verbosity: 'verbose',
      },
    }));

    spy.mockRestore();
  });
});

describe('pdbGet', () => {
  let originalFetch: typeof global.fetch;
  let mockRequest: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    connectionManager.closeAll();
    mockRequest = jest.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    connectionManager.closeAll();
  });

  const minimalEntryData = {
    struct: { title: 'HEMOGLOBIN' },
    rcsb_entry_container_identifiers: {
      polymer_entity_ids: ['1'],
      non_polymer_entity_ids: [],
      assembly_ids: ['1'],
    },
  };

  it('fetches entry and returns PdbResult with summary', async () => {
    mockRequest.mockResolvedValue(minimalEntryData);

    const spy = jest.spyOn(connectionManager, 'getConnection').mockImplementation((_sourceId: string) => {
      return createMockConnection({ request: mockRequest }) as any;
    });

    const result = await pdbGet('4HHB');

    expect(result.pdb_id).toBe('4HHB');
    expect(result.summary).toBeDefined();
    expect(result.summary.title).toBe('HEMOGLOBIN');
    expect(result.sections).toBeUndefined();

    spy.mockRestore();
  });

  it('fetches entry with sections', async () => {
    mockRequest.mockResolvedValue(minimalEntryData);

    const spy = jest.spyOn(connectionManager, 'getConnection').mockImplementation((_sourceId: string) => {
      return createMockConnection({ request: mockRequest }) as any;
    });

    const result = await pdbGet('4HHB', ['polymer_entities']);

    expect(result.sections).toBeDefined();
    expect(result.sections!.polymer_entities).toBeDefined();

    spy.mockRestore();
  });

  it('fetches all 5 sections when "all" is specified', async () => {
    const entryData = {
      struct: { title: 'HEMOGLOBIN' },
      exptl: [{ method: 'X-RAY DIFFRACTION' }],
      rcsb_primary_citation: {
        title: 'Hemoglobin structure',
        authors: [{ name: 'Author1' }],
      },
      rcsb_entry_container_identifiers: {
        polymer_entity_ids: ['1'],
        non_polymer_entity_ids: ['2'],
        assembly_ids: ['1'],
      },
    };
    mockRequest.mockResolvedValue(entryData);

    const spy = jest.spyOn(connectionManager, 'getConnection').mockImplementation((_sourceId: string) => {
      return createMockConnection({ request: mockRequest }) as any;
    });

    const result = await pdbGet('4HHB', ['all']);

    expect(result.sections).toBeDefined();
    const sectionKeys = Object.keys(result.sections!);
    expect(sectionKeys).toContain('polymer_entities');
    expect(sectionKeys).toContain('ligands');
    expect(sectionKeys).toContain('assembly');
    expect(sectionKeys).toContain('experiment');
    expect(sectionKeys).toContain('citation');

    spy.mockRestore();
  });

  it('throws for invalid PDB ID before making API call', async () => {
    const spy = jest.spyOn(connectionManager, 'getConnection').mockImplementation((_sourceId: string) => {
      return createMockConnection({ request: mockRequest }) as any;
    });

    await expect(pdbGet('INVALID')).rejects.toThrow('Invalid PDB ID');
    expect(mockRequest).not.toHaveBeenCalled();

    spy.mockRestore();
  });

  it('throws when entry fetch returns no data', async () => {
    // fetchWithTimeout returns { error: ... } when conn.request fails
    // Simulate by having the request throw
    mockRequest.mockRejectedValue(new Error('HTTP 404: Not Found'));

    const spy = jest.spyOn(connectionManager, 'getConnection').mockImplementation((_sourceId: string) => {
      return createMockConnection({ request: mockRequest }) as any;
    });

    await expect(pdbGet('4HHB')).rejects.toThrow();

    spy.mockRestore();
  });

  it('handles experiment section with raw entry data', async () => {
    const entryData = {
      struct: { title: 'HEMOGLOBIN' },
      exptl: [{ method: 'X-RAY DIFFRACTION' }],
      refine: [{ ls_d_res_high: 1.74, ls_d_res_low: 20.0, rfactor_free: 0.25, rfactor_work: 0.20 }],
      rcsb_entry_container_identifiers: {
        polymer_entity_ids: [],
        non_polymer_entity_ids: [],
        assembly_ids: [],
      },
    };
    mockRequest.mockResolvedValue(entryData);

    const spy = jest.spyOn(connectionManager, 'getConnection').mockImplementation((_sourceId: string) => {
      return createMockConnection({ request: mockRequest }) as any;
    });

    const result = await pdbGet('4HHB', ['experiment']);

    expect(result.sections).toBeDefined();
    const exp = result.sections!.experiment as any;
    expect(exp).toBeDefined();
    expect(exp.methods).toEqual(['X-RAY DIFFRACTION']);
    expect(exp.refinement).toBeDefined();
    expect(exp.refinement[0].resolution_high).toBe(1.74);

    spy.mockRestore();
  });

  it('handles citation section with primary citation', async () => {
    const entryData = {
      struct: { title: 'HEMOGLOBIN' },
      rcsb_primary_citation: {
        title: 'Structure of hemoglobin',
        pdbx_database_id_DOI: '10.1234/test',
        pdbx_database_id_PubMed: '12345',
        authors: [{ name: 'Smith J' }, { name: 'Doe A' }],
        journal_abbrev: 'Nature',
        year: 2020,
      },
      rcsb_entry_container_identifiers: {
        polymer_entity_ids: [],
        non_polymer_entity_ids: [],
        assembly_ids: [],
      },
    };
    mockRequest.mockResolvedValue(entryData);

    const spy = jest.spyOn(connectionManager, 'getConnection').mockImplementation((_sourceId: string) => {
      return createMockConnection({ request: mockRequest }) as any;
    });

    const result = await pdbGet('4HHB', ['citation']);

    expect(result.sections).toBeDefined();
    const cit = result.sections!.citation as any;
    expect(cit).toBeDefined();
    expect(cit.title).toBe('Structure of hemoglobin');
    expect(cit.doi).toBe('10.1234/test');
    expect(cit.pmid).toBe('12345');
    expect(cit.authors).toEqual(['Smith J', 'Doe A']);
    expect(cit.journal).toBe('Nature');
    expect(cit.year).toBe(2020);

    spy.mockRestore();
  });
});

describe('pdbDownload', () => {
  let originalFetch: typeof global.fetch;
  let mockRequest: jest.Mock;
  let tempFiles: string[] = [];

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    connectionManager.closeAll();
    mockRequest = jest.fn();
    tempFiles = [];
  });

  afterEach(() => {
    global.fetch = originalFetch;
    connectionManager.closeAll();
    // Clean up any temp files
    for (const f of tempFiles) {
      try {
        if (existsSync(f)) unlinkSync(f);
      } catch {
        // ignore
      }
    }
  });

  it('downloads cif format successfully', async () => {
    const fileContent = 'data_pdb_TEST\n# some CIF content';
    mockRequest.mockResolvedValue(fileContent);

    const spy = jest.spyOn(connectionManager, 'getConnection').mockImplementation((_sourceId: string) => {
      return createMockConnection({ request: mockRequest }) as any;
    });

    const result = await pdbDownload('4HHB', 'cif');

    expect(result.pdb_id).toBe('4HHB');
    expect(result.format).toBe('cif');
    expect(result.file_path).toContain('.cif');
    expect(result.file_size_bytes).toBe(Buffer.byteLength(fileContent, 'utf-8'));
    expect(result.file_size_human).toBe(formatFileSize(result.file_size_bytes));
    expect(result._warn).toBeUndefined();

    tempFiles.push(result.file_path);

    spy.mockRestore();
  });

  it('downloads pdb format with correct extension', async () => {
    const fileContent = 'HEADER TEST';
    mockRequest.mockResolvedValue(fileContent);

    const spy = jest.spyOn(connectionManager, 'getConnection').mockImplementation((_sourceId: string) => {
      return createMockConnection({ request: mockRequest }) as any;
    });

    const result = await pdbDownload('4HHB', 'pdb');

    expect(result.format).toBe('pdb');
    expect(result.file_path).toContain('.pdb');
    expect(result.pdb_id).toBe('4HHB');

    tempFiles.push(result.file_path);

    spy.mockRestore();
  });

  it('throws helpful message on 404 for pdb format', async () => {
    mockRequest.mockRejectedValue(new Error('HTTP 404: Not Found'));

    const spy = jest.spyOn(connectionManager, 'getConnection').mockImplementation((_sourceId: string) => {
      return createMockConnection({ request: mockRequest }) as any;
    });

    await expect(pdbDownload('4HHB', 'pdb')).rejects.toThrow('PDB format not available for 4HHB');

    spy.mockRestore();
  });

  it('includes _warn for files larger than 1MB', async () => {
    // Create content > 1MB
    const largeContent = 'X'.repeat(1_000_001);
    mockRequest.mockResolvedValue(largeContent);

    const spy = jest.spyOn(connectionManager, 'getConnection').mockImplementation((_sourceId: string) => {
      return createMockConnection({ request: mockRequest }) as any;
    });

    const result = await pdbDownload('4HHB', 'cif');

    expect(result._warn).toBeDefined();
    expect(result._warn).toContain('large');
    expect(result.file_size_bytes).toBeGreaterThan(1_000_000);

    tempFiles.push(result.file_path);

    spy.mockRestore();
  });

  it('validates PDB ID before downloading', async () => {
    await expect(pdbDownload('INVALID')).rejects.toThrow('Invalid PDB ID');
  });

  it('re-throws non-404 errors', async () => {
    mockRequest.mockRejectedValue(new Error('HTTP 500: Server Error'));

    const spy = jest.spyOn(connectionManager, 'getConnection').mockImplementation((_sourceId: string) => {
      return createMockConnection({ request: mockRequest }) as any;
    });

    await expect(pdbDownload('4HHB', 'cif')).rejects.toThrow('HTTP 500');

    spy.mockRestore();
  });
});
