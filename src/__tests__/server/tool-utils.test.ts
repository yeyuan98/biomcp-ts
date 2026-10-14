import { describe, test, expect } from '@jest/globals';
import { applyLimit, sliceArraysRecursive } from '../../server/tools/utils.js';

// ---------------------------------------------------------------------------
// sliceArraysRecursive
// ---------------------------------------------------------------------------

describe('sliceArraysRecursive', () => {
  test('slices top-level arrays', () => {
    const arr = [1, 2, 3, 4, 5];
    expect(sliceArraysRecursive(arr, 3)).toEqual([1, 2, 3]);
  });

  test('recursively slices nested objects with arrays', () => {
    const input = {
      a: [1, 2, 3, 4],
      b: { c: [10, 20, 30, 40, 50] },
    };
    const result = sliceArraysRecursive(input, 2) as Record<string, unknown>;
    expect(result.a).toEqual([1, 2]);
    const b = result.b as Record<string, unknown>;
    expect(b.c).toEqual([10, 20]);
  });

  test('returns primitives unchanged', () => {
    expect(sliceArraysRecursive(42, 5)).toBe(42);
    expect(sliceArraysRecursive('hello', 5)).toBe('hello');
    expect(sliceArraysRecursive(true, 5)).toBe(true);
  });

  test('handles null and undefined', () => {
    expect(sliceArraysRecursive(null, 5)).toBe(null);
    expect(sliceArraysRecursive(undefined, 5)).toBe(undefined);
  });

  test('handles empty objects and arrays', () => {
    expect(sliceArraysRecursive({}, 5)).toEqual({});
    expect(sliceArraysRecursive([], 5)).toEqual([]);
  });

  test('preserves non-array values inside objects', () => {
    const input = { name: 'test', items: [1, 2, 3] };
    const result = sliceArraysRecursive(input, 1) as Record<string, unknown>;
    expect(result.name).toBe('test');
    expect(result.items).toEqual([1]);
  });

  test('handles deeply nested structures', () => {
    const input = {
      level1: {
        level2: {
          level3: [1, 2, 3, 4, 5],
        },
      },
    };
    const result = sliceArraysRecursive(input, 2) as Record<string, unknown>;
    const l1 = result.level1 as Record<string, unknown>;
    const l2 = l1.level2 as Record<string, unknown>;
    expect(l2.level3).toEqual([1, 2]);
  });
});

// ---------------------------------------------------------------------------
// applyLimit
// ---------------------------------------------------------------------------

describe('applyLimit', () => {
  test('limits arrays in sections by section name (return value, input untouched)', () => {
    const sections: Record<string, unknown> = {
      items: [1, 2, 3, 4, 5],
    };
    const limited = applyLimit(sections, ['items'], {}, {}, 2);
    expect(limited.items).toEqual([1, 2]);
    // The input is never mutated — callers may be holding cached objects.
    expect(sections.items).toEqual([1, 2, 3, 4, 5]);
  });

  test('respects storageKeyMap (maps section name to storage key)', () => {
    const sections: Record<string, unknown> = {
      civic: [1, 2, 3, 4],
    };
    const limited = applyLimit(sections, ['clinical_evidence'], { clinical_evidence: 'civic' }, {}, 2);
    expect(limited.civic).toEqual([1, 2]);
    expect(sections.civic).toEqual([1, 2, 3, 4]);
  });

  test('respects arrayKeyMap (limits specific array keys within section objects)', () => {
    const sections: Record<string, unknown> = {
      outcomes: {
        primary: ['p1', 'p2', 'p3'],
        secondary: ['s1', 's2', 's3'],
        meta: 'unchanged',
      },
    };
    const limited = applyLimit(
      sections,
      ['outcomes'],
      {},
      { outcomes: ['primary', 'secondary'] },
      1,
    );
    const outcomes = limited.outcomes as Record<string, unknown>;
    expect(outcomes.primary).toEqual(['p1']);
    expect(outcomes.secondary).toEqual(['s1']);
    expect(outcomes.meta).toBe('unchanged');
    // Input deep-unchanged: neither the section object nor its arrays moved.
    const inputOutcomes = sections.outcomes as Record<string, unknown>;
    expect(inputOutcomes.primary).toEqual(['p1', 'p2', 'p3']);
    expect(inputOutcomes.secondary).toEqual(['s1', 's2', 's3']);
    expect(inputOutcomes.meta).toBe('unchanged');
  });

  test('does not mutate the input even when multiple sections are sliced', () => {
    const sections: Record<string, unknown> = {
      graph: { citations: [1, 2, 3, 4], references: [5, 6, 7, 8] },
      annotations: [1, 2, 3],
    };
    const snapshot = JSON.parse(JSON.stringify(sections));
    const limited = applyLimit(
      sections,
      ['graph', 'annotations'],
      {},
      { graph: ['citations', 'references'] },
      2,
    );
    const graph = limited.graph as Record<string, unknown>;
    expect(graph.citations).toEqual([1, 2]);
    expect(graph.references).toEqual([5, 6]);
    expect(limited.annotations).toEqual([1, 2]);
    expect(sections).toEqual(snapshot);
  });

  test('non-cited sections keep their identity in the returned object', () => {
    const untouched = { deep: [1, 2, 3] };
    const sections: Record<string, unknown> = {
      untouched,
      items: [1, 2, 3, 4, 5],
    };
    const limited = applyLimit(sections, ['items'], {}, {}, 2);
    expect(limited.untouched).toBe(untouched); // same reference, not a copy
    expect(limited.items).toEqual([1, 2]);
  });

  test('returns the input object itself when nothing is sliced', () => {
    const sections: Record<string, unknown> = {
      foo: [1, 2, 3],
    };
    const limited = applyLimit(sections, ['bar'], { bar: 'baz' }, {}, 1);
    expect(limited).toBe(sections);
    expect(limited.foo).toEqual([1, 2, 3]);
  });

  test('object section without any arrayKeyMap arrays is not replaced', () => {
    const sectionObj = { meta: 'keep' };
    const sections: Record<string, unknown> = {
      outcomes: sectionObj,
    };
    const limited = applyLimit(sections, ['outcomes'], {}, { outcomes: ['primary'] }, 1);
    expect(limited.outcomes).toBe(sectionObj);
  });

  test('handles missing sections gracefully', () => {
    const sections: Record<string, unknown> = {
      existing: [1, 2, 3],
    };
    // Should not throw when requesting a section that does not exist
    expect(() => {
      applyLimit(sections, ['nonexistent'], {}, {}, 1);
    }).not.toThrow();
    // Existing section should be untouched because it wasn't requested
    expect(sections.existing).toEqual([1, 2, 3]);
  });

  test('handles sections that are arrays directly', () => {
    const sections: Record<string, unknown> = {
      items: [10, 20, 30, 40],
    };
    const limited = applyLimit(sections, ['items'], {}, { items: [] }, 2);
    expect(limited.items).toEqual([10, 20]);
    expect(sections.items).toEqual([10, 20, 30, 40]);
  });

  test('does nothing when no matching sections found', () => {
    const sections: Record<string, unknown> = {
      foo: [1, 2, 3],
    };
    const limited = applyLimit(sections, ['bar'], { bar: 'baz' }, {}, 1);
    expect(limited.foo).toEqual([1, 2, 3]);
  });

  test('skips sections with non-object data', () => {
    const sections: Record<string, unknown> = {
      name: 'a string value',
      items: [1, 2, 3],
    };
    const limited = applyLimit(sections, ['name', 'items'], {}, {}, 1);
    expect(limited.name).toBe('a string value');
    expect(limited.items).toEqual([1]);
    expect(sections.items).toEqual([1, 2, 3]);
  });

  test('uses section name directly when not in storageKeyMap', () => {
    const sections: Record<string, unknown> = {
      pathways: [1, 2, 3, 4, 5],
    };
    const limited = applyLimit(sections, ['pathways'], {}, {}, 3);
    expect(limited.pathways).toEqual([1, 2, 3]);
    expect(sections.pathways).toEqual([1, 2, 3, 4, 5]);
  });

  test('arrayKeyMap with empty array falls back to array check', () => {
    const sections: Record<string, unknown> = {
      targets: [1, 2, 3],
    };
    const limited = applyLimit(sections, ['targets'], {}, { targets: [] }, 1);
    expect(limited.targets).toEqual([1]);
    expect(sections.targets).toEqual([1, 2, 3]);
  });
});
