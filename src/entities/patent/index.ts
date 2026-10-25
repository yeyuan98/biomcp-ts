export type {
  PatentSource,
  PatentStatus,
  PatentSortBy,
  PatentSearchOptions,
  PatentSearchResult,
  PatentSearchResponse,
  PatentSeminalEntry,
  PatentCitationEntry,
  PatentClaimsSection,
  PatentCitationsSection,
  PatentFamilySection,
  PatentClassificationsSection,
  PatentResult,
} from './types.js';

export {
  patentSearch,
  PATENT_SEARCH_SOURCES,
  PATENT_SEARCH_TOOL_BUDGET_MS,
  selectSearchBackends,
  dedupPatents,
  normalizePublicationNumber,
  isValidPublicationNumber,
} from './search/index.js';

export { patentGet, PATENT_GET_SECTIONS } from './detail/index.js';

export type { PatentGetSection } from './detail/index.js';

// Deadline-slicing budget table for patent_get (issue #209); exported for
// the arithmetic invariant test, mirroring PATENT_SEARCH_TOOL_BUDGET_MS.
export { PATENT_GET_BUDGETS_MS } from './detail/index.js';

export { OpsClient, opsClient, hasOpsCredentials } from './ops-client.js';
export { PpubsClient, ppubsClient } from './ppubs-client.js';
