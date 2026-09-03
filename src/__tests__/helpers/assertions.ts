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

/**
 * article_get `oa` section: must be a non-error result carrying OA metadata
 * from either source (pmc_oa primary, europepmc fallback) — a `_error` here
 * means both OA lookup legs failed.
 */
export function expectArticleOaSection(data: unknown): void {
  const section = (data as any)?.sections?.open_access;
  expect(section).toBeDefined();
  expect(section._error).toBeUndefined();
  expect(['pmc_oa', 'europepmc']).toContain(section.source);
  expect(typeof section.pmcid).toBe('string');
  const hasOaSignal = section.license !== undefined || section.pdf_url !== undefined;
  expect(hasOaSignal).toBe(true);
}

/**
 * article_get `citation` section with the crossref invariant: a provider row
 * must never be silently empty — either data arrived or an explicit error is
 * recorded. Guards the bug where a transform TypeError zeroed crossref's
 * count and backward references without any error signal.
 */
export function expectCitationSection(data: unknown): void {
  const section = (data as any)?.sections?.citation;
  expect(section).toBeDefined();
  expect(Array.isArray(section.citation_counts)).toBe(true);
  expect(Array.isArray(section.source_results)).toBe(true);
  expect(section.citation_counts.length).toBeGreaterThan(0);

  const crossref = section.source_results.find((s: any) => s.source_id === 'crossref');
  expect(crossref).toBeDefined();
  const hasData = (crossref.citation_count?.total ?? 0) > 0 || (crossref.backward_references?.length ?? 0) > 0;
  const hasError = typeof crossref.error === 'string' && crossref.error.length > 0;
  expect(hasData || hasError).toBe(true);
}

/**
 * drug_get `adverse_events` section: FDA FAERS aggregate — total report
 * count plus reactions ranked by count. Exact counts fluctuate daily, so
 * only shape and positivity are asserted.
 */
export function expectDrugAdverseEventsSection(data: unknown): void {
  const section = (data as any)?.sections?.adverse_events;
  expect(section).toBeDefined();
  expect(section._error).toBeUndefined();
  expect(typeof section.total_reports).toBe('number');
  expect(section.total_reports).toBeGreaterThan(0);
  expect(Array.isArray(section.reactions)).toBe(true);
  expect(section.reactions.length).toBeGreaterThan(0);
  for (const r of section.reactions) {
    expect(typeof r.reaction).toBe('string');
    expect(r.count).toBeGreaterThan(0);
    expect(r.source).toBe('openfda');
  }
  for (let i = 1; i < section.reactions.length; i++) {
    expect(section.reactions[i - 1].count).toBeGreaterThanOrEqual(section.reactions[i].count);
  }
}
