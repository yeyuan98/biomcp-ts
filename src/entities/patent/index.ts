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
  selectSearchBackends,
  dedupPatents,
  normalizePublicationNumber,
  isValidPublicationNumber,
} from './search/index.js';

export { patentGet, PATENT_GET_SECTIONS } from './detail/index.js';

export type { PatentGetSection } from './detail/index.js';

export { OpsClient, opsClient, hasOpsCredentials } from './ops-client.js';
export { PpubsClient, ppubsClient } from './ppubs-client.js';
