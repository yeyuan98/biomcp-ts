import { validateInput, InputValidation, formatValidationErrors, isValidEntityInput, getEntitySuggestions } from '../../server/validation.js';

describe('validateInput', () => {
  it('returns success for valid gene symbol', () => {
    const result = validateInput(InputValidation.geneSymbol, 'BRAF');
    expect(result).toEqual({ success: true, data: 'BRAF' });
  });

  it('returns failure for invalid gene symbol', () => {
    const result = validateInput(InputValidation.geneSymbol, '123 bad!');
    expect(result.success).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBeGreaterThan(0);
  });
});

describe('InputValidation.geneSymbol', () => {
  it('rejects empty string', () => {
    const result = InputValidation.geneSymbol.safeParse('');
    expect(result.success).toBe(false);
  });

  it('rejects special characters like "BRAF@#"', () => {
    const result = InputValidation.geneSymbol.safeParse('BRAF@#');
    expect(result.success).toBe(false);
  });
});

describe('InputValidation.nctId', () => {
  it('accepts valid format "NCT01234567"', () => {
    const result = InputValidation.nctId.safeParse('NCT01234567');
    expect(result.success).toBe(true);
  });

  it('rejects too short "NCT123"', () => {
    const result = InputValidation.nctId.safeParse('NCT123');
    expect(result.success).toBe(false);
  });
});

describe('InputValidation.articleId', () => {
  it('accepts PMID "12345678"', () => {
    const result = InputValidation.articleId.safeParse('12345678');
    expect(result.success).toBe(true);
  });

  it('accepts PMCID "PMC1234567"', () => {
    const result = InputValidation.articleId.safeParse('PMC1234567');
    expect(result.success).toBe(true);
  });

  it('accepts DOI "10.1038/s41586-021-03819-2"', () => {
    const result = InputValidation.articleId.safeParse('10.1038/s41586-021-03819-2');
    expect(result.success).toBe(true);
  });

  it('rejects non-numeric non-PMCID non-DOI "PM123"', () => {
    const result = InputValidation.articleId.safeParse('PM123');
    expect(result.success).toBe(false);
  });
});

describe('InputValidation.drugName', () => {
  it('accepts "imatinib"', () => {
    const result = InputValidation.drugName.safeParse('imatinib');
    expect(result.success).toBe(true);
  });

  it('rejects empty string', () => {
    const result = InputValidation.drugName.safeParse('');
    expect(result.success).toBe(false);
  });
});

describe('InputValidation.diseaseQuery', () => {
  it('accepts "lung cancer"', () => {
    const result = InputValidation.diseaseQuery.safeParse('lung cancer');
    expect(result.success).toBe(true);
  });
});

describe('InputValidation.limit', () => {
  it('accepts 10', () => {
    const result = InputValidation.limit.safeParse(10);
    expect(result.success).toBe(true);
  });

  it('rejects 101', () => {
    const result = InputValidation.limit.safeParse(101);
    expect(result.success).toBe(false);
  });
});

describe('formatValidationErrors', () => {
  it('formats single error as multiline string', () => {
    const result = formatValidationErrors([{ path: 'name', message: 'Required' }]);
    expect(result).toContain('Validation failed:');
    expect(result).toContain('- name: Required');
  });

  it('formats multiple errors with multiple "- " lines', () => {
    const result = formatValidationErrors([
      { path: 'name', message: 'Required' },
      { path: 'email', message: 'Invalid format' },
    ]);
    expect(result).toContain('- name: Required');
    expect(result).toContain('- email: Invalid format');
  });
});

describe('isValidEntityInput', () => {
  it('returns true for valid gene input', () => {
    expect(isValidEntityInput('gene', 'BRAF')).toBe(true);
  });

  it('returns true for valid variant input', () => {
    expect(isValidEntityInput('variant', 'rs1134882')).toBe(true);
  });

  it('returns true for valid drug input', () => {
    expect(isValidEntityInput('drug', 'imatinib')).toBe(true);
  });

  it('returns true for valid disease input', () => {
    expect(isValidEntityInput('disease', 'lung cancer')).toBe(true);
  });

  it('returns true for valid trial NCT ID input', () => {
    expect(isValidEntityInput('trial', 'NCT01234567')).toBe(true);
  });

  it('returns true for valid article PMID input', () => {
    expect(isValidEntityInput('article', '12345678')).toBe(true);
  });

  it('returns true for valid article PMCID input', () => {
    expect(isValidEntityInput('article', 'PMC1234567')).toBe(true);
  });

  it('returns true for valid article DOI input', () => {
    expect(isValidEntityInput('article', '10.1038/s41586-021-03819-2')).toBe(true);
  });

  it('returns true for valid patent publication numbers', () => {
    expect(isValidEntityInput('patent', 'US11027025B2')).toBe(true);
    expect(isValidEntityInput('patent', 'EP3904939')).toBe(true);
    expect(isValidEntityInput('patent', 'US20260240819A1')).toBe(true);
    expect(isValidEntityInput('patent', 'us 11027025 b2')).toBe(true);
  });

  it('returns false for invalid patent input', () => {
    expect(isValidEntityInput('patent', 'crispr')).toBe(false);
    expect(isValidEntityInput('patent', '12345')).toBe(false);
  });
});

describe('getEntitySuggestions', () => {
  it('returns suggestion for gene', () => {
    expect(getEntitySuggestions('gene')).toContain('gene_search');
  });

  it('returns suggestion for variant', () => {
    expect(getEntitySuggestions('variant')).toContain('variant_search');
  });

  it('returns suggestion for drug', () => {
    expect(getEntitySuggestions('drug')).toContain('drug_search');
  });

  it('returns suggestion for disease', () => {
    expect(getEntitySuggestions('disease')).toContain('disease_search');
  });

  it('returns suggestion for trial', () => {
    expect(getEntitySuggestions('trial')).toContain('trial_search');
  });

  it('returns suggestion for article mentioning PMCID and DOI', () => {
    const suggestion = getEntitySuggestions('article');
    expect(suggestion).toContain('article_search');
    expect(suggestion).toContain('PMCID');
  });

  it('returns suggestion for patent mentioning patent_search', () => {
    expect(getEntitySuggestions('patent')).toContain('patent_search');
  });

  it('returns fallback for unknown entity', () => {
    expect(getEntitySuggestions('foo')).toContain('Check the entity type');
  });
});
