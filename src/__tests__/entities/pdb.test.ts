import { jest } from '@jest/globals';
import { validatePdbId, formatFileSize } from '../../entities/pdb.js';

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
