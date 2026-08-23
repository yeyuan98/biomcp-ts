export function expectGeneSearchResult(data: unknown): asserts data is Array<Record<string, unknown>> {
  expect(Array.isArray(data)).toBe(true);
  if (data.length > 0) {
    const first = data[0] as Record<string, unknown>;
    expect(first).toHaveProperty('symbol');
    expect(first).toHaveProperty('name');
    expect(typeof first.symbol).toBe('string');
    expect(typeof first.name).toBe('string');
  }
}

export function expectGeneGetResult(data: unknown): asserts data is Record<string, unknown> {
  expect(data).toHaveProperty('symbol');
  expect(data).toHaveProperty('name');
  expect(typeof (data as Record<string, unknown>).symbol).toBe('string');
  expect(typeof (data as Record<string, unknown>).name).toBe('string');
}

export function expectDrugSearchResult(data: unknown): asserts data is Array<Record<string, unknown>> {
  expect(Array.isArray(data)).toBe(true);
  if (data.length > 0) {
    const first = data[0] as Record<string, unknown>;
    expect(first).toHaveProperty('name');
    expect(typeof first.name).toBe('string');
  }
}

export function expectDrugGetResult(data: unknown): asserts data is Record<string, unknown> {
  expect(data).toHaveProperty('name');
  expect(typeof (data as Record<string, unknown>).name).toBe('string');
}

export function expectVariantSearchResult(data: unknown): asserts data is Array<Record<string, unknown>> {
  expect(Array.isArray(data)).toBe(true);
  if (data.length > 0) {
    const first = data[0] as Record<string, unknown>;
    expect(first).toHaveProperty('id');
    expect(typeof first.id).toBe('string');
  }
}

export function expectVariantGetResult(data: unknown): asserts data is Record<string, unknown> {
  expect(data).toHaveProperty('id');
  expect(typeof (data as Record<string, unknown>).id).toBe('string');
}

export function expectDiseaseSearchResult(data: unknown): asserts data is Array<Record<string, unknown>> {
  expect(Array.isArray(data)).toBe(true);
  if (data.length > 0) {
    const first = data[0] as Record<string, unknown>;
    expect(first).toHaveProperty('name');
    expect(first).toHaveProperty('disease_id');
    expect(typeof first.name).toBe('string');
    expect(typeof first.disease_id).toBe('string');
  }
}

export function expectDiseaseGetResult(data: unknown): asserts data is Record<string, unknown> {
  expect(data).toHaveProperty('name');
  expect(data).toHaveProperty('disease_id');
  expect(typeof (data as Record<string, unknown>).name).toBe('string');
  expect(typeof (data as Record<string, unknown>).disease_id).toBe('string');
}

export function expectArticleSearchResult(data: unknown): asserts data is Array<Record<string, unknown>> {
  expect(Array.isArray(data)).toBe(true);
  if (data.length > 0) {
    const first = data[0] as Record<string, unknown>;
    expect(first).toHaveProperty('title');
    expect(typeof first.title).toBe('string');
  }
}

export function expectArticleGetResult(data: unknown): asserts data is Record<string, unknown> {
  expect(data).toHaveProperty('title');
  expect(typeof (data as Record<string, unknown>).title).toBe('string');
}

export function expectTrialSearchResult(data: unknown): asserts data is { studies: Array<Record<string, unknown>>; nextPageToken?: string } {
  expect(data).toHaveProperty('studies');
  expect(Array.isArray((data as any).studies)).toBe(true);
  if ((data as any).studies.length > 0) {
    const first = (data as any).studies[0] as Record<string, unknown>;
    expect(first).toHaveProperty('nct_id');
    expect(typeof first.nct_id).toBe('string');
  }
}

export function expectTrialGetResult(data: unknown): asserts data is Record<string, unknown> {
  expect(data).toHaveProperty('nct_id');
  expect(typeof (data as Record<string, unknown>).nct_id).toBe('string');
}

export function expectPatentSearchResult(data: unknown): asserts data is { patents: Array<Record<string, unknown>>; total_hits?: Record<string, unknown> } {
  expect(data).toHaveProperty('patents');
  expect(Array.isArray((data as any).patents)).toBe(true);
  for (const p of (data as any).patents as Array<Record<string, unknown>>) {
    expect(p).toHaveProperty('source');
    if (!(p as any)._error) {
      expect(typeof p.publication_number).toBe('string');
      expect(p.publication_number).toMatch(/^[A-Z]{2}/);
    }
  }
}

export function expectPatentGetResult(data: unknown): asserts data is Record<string, unknown> {
  expect(data).toHaveProperty('publication_number');
  expect(typeof (data as Record<string, unknown>).publication_number).toBe('string');
}
