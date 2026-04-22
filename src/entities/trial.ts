import { connectionManager } from '../connections/manager.js';

const SECTION_TIMEOUT_MS = 8000;

export interface TrialSearchOptions {
  status?: string;
  phase?: string;
  intervention_type?: string;
  limit?: number;
  offset?: number;
}

export interface TrialSearchResult {
  nct_id: string;
  title?: string;
  status?: string;
  phase?: string;
  conditions?: string[];
  interventions?: string[];
  sponsor?: string;
}

export interface TrialGetOptions {
  sections?: string[];
}

export interface TrialResult {
  nct_id: string;
  title?: string;
  short_title?: string;
  status?: string;
  phase?: string;
  conditions?: string[];
  interventions?: string[];
  sponsor?: string;
  collaborator?: string;
  contacts?: Array<{ role: string; name: string; phone?: string; email?: string }>;
  sections?: Record<string, unknown>;
}

async function fetchWithTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<{ data?: T; error?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const data = await fn();
    return { data };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    if (error.includes('abort') || error.includes('timeout')) {
      return { error: `Timeout after ${timeoutMs}ms` };
    }
    return { error };
  } finally {
    clearTimeout(timeout);
  }
}

export async function trialSearch(
  query: string,
  options: TrialSearchOptions = {}
): Promise<TrialSearchResult[]> {
  const { status, phase, intervention_type, limit = 10, offset = 0 } = options;
  
  const conn = connectionManager.getConnection('clinicaltrials');
  
  const queryParams = new URLSearchParams({
    'query.cond': query,
    pageSize: String(limit),
    format: 'json',
  });
  
  if (status) {
    queryParams.set('query.status', status);
  }
  
  if (phase) {
    queryParams.set('query.phase', phase);
  }
  
  if (intervention_type) {
    queryParams.set('query.intr_type', intervention_type);
  }
  
  const response = await conn.request(`/studies?${queryParams.toString()}`) as ClinicalTrialsSearchResponse;
  
  return (response.studies || []).map(transformTrialSearchResult);
}

export async function trialGet(
  nctId: string,
  sections?: string[]
): Promise<TrialResult> {
  const sectionConfig = sections || ['core'];
  
  const conn = connectionManager.getConnection('clinicaltrials');
  
  const response = await conn.request(
    `/studies/${encodeURIComponent(nctId)}?format=json`
  ) as ClinicalTrialsDetailResponse;
  
  if (!response.studies || response.studies.length === 0) {
    throw new Error(`Trial '${nctId}' not found. Try trial_search to find valid NCT IDs.`);
  }
  
  const trial = response.studies[0];
const identModule = trial.protocolSection?.identModule;
  const statusModule = trial.protocolSection?.statusModule;
  const descModule = trial.protocolSection?.descModule;
  const armsModule = trial.protocolSection?.armsModule;
  const contactsModule = trial.protocolSection?.contactsModule;
  
  const result: TrialResult = {
    nct_id: identModule?.nctId || nctId,
    title: identModule?.briefTitle,
    short_title: identModule?.shortTitle,
    status: statusModule?.overallStatus,
    phase: statusModule?.phases?.[0],
    conditions: descModule?.conditions,
    interventions: armsModule?.interventions?.map((i: { type: string; name: string }) => `${i.type}: ${i.name}`),
    sponsor: identModule?.sponsors?.[0]?.name,
    collaborator: identModule?.collaborators?.[0]?.name,
  };
  
  if (contactsModule?.contacts) {
    result.contacts = contactsModule.contacts.map((c: { role?: string; name?: string; phone?: string; email?: string }) => ({
      role: c.role || 'contact',
      name: c.name || '',
      phone: c.phone,
      email: c.email,
    }));
  }
  
  const sectionsToFetch = sectionConfig.includes('all') 
    ? ['eligibility', 'locations', 'outcomes']
    : sectionConfig.filter(s => s !== 'core');

  if (sectionsToFetch.length > 0) {
    const sectionPromises = sectionsToFetch.map(section => {
      return fetchWithTimeout(async () => {
        switch (section) {
          case 'eligibility': return { section: 'eligibility', data: await fetchEligibility(nctId) };
          case 'locations': return { section: 'locations', data: await fetchLocations(nctId) };
          case 'outcomes': return { section: 'outcomes', data: await fetchOutcomes(nctId) };
          default: return { section, data: null };
        }
      }, SECTION_TIMEOUT_MS);
    });

    const settledResults = await Promise.allSettled(sectionPromises);
    
    result.sections = {};
    for (const settled of settledResults) {
      if (settled.status === 'fulfilled' && settled.value.data) {
        const sectionData = settled.value.data as { section: string; data: unknown };
        (result.sections as Record<string, unknown>)[sectionData.section] = sectionData.data;
      } else if (settled.status === 'fulfilled' && settled.value.error) {
        const sectionResult = settled.value as { error?: string };
        (result.sections as Record<string, unknown>)[sectionsToFetch[settledResults.indexOf(settled)]] = { 
          error: sectionResult.error 
        };
      }
    }
  }
  
  return result;
}

async function fetchEligibility(nctId: string): Promise<{ criteria?: string; minimum_age?: string; maximum_age?: string; sex?: string; healthy_volunteers?: boolean }> {
  try {
    const conn = connectionManager.getConnection('clinicaltrials');
    
    const response = await conn.request(
      `/studies/${encodeURIComponent(nctId)}?format=json`
    ) as ClinicalTrialsDetailResponse;
    
    const eligibilityModule = response.studies?.[0]?.protocolSection?.eligModule;
    
    if (!eligibilityModule) return {};
    
    return {
      criteria: eligibilityModule.eligibilityCriteria,
      minimum_age: eligibilityModule.minimumAge,
      maximum_age: eligibilityModule.maximumAge,
      sex: eligibilityModule.sex,
      healthy_volunteers: eligibilityModule.healthyVolunteers,
    };
  } catch {
    return {};
  }
}

async function fetchLocations(nctId: string): Promise<Array<{ facility?: string; city?: string; state?: string; country?: string; zip?: string; status?: string }>> {
  try {
    const conn = connectionManager.getConnection('clinicaltrials');
    
    const response = await conn.request(
      `/studies/${encodeURIComponent(nctId)}?format=json`
    ) as ClinicalTrialsDetailResponse;
    
    const locations = response.studies?.[0]?.protocolSection?.contactsModule?.locations;
    
    if (!locations) return [];
    
    return locations.map((l: { facility?: string; city?: string; state?: string; country?: string; zip?: string; status?: string }) => ({
      facility: l.facility,
      city: l.city,
      state: l.state,
      country: l.country,
      zip: l.zip,
      status: l.status,
    }));
  } catch {
    return [];
  }
}

async function fetchOutcomes(nctId: string): Promise<{ primary?: Array<{ measure?: string; timeframe?: string }>; secondary?: Array<{ measure?: string; timeframe?: string }> }> {
  try {
    const conn = connectionManager.getConnection('clinicaltrials');
    
    const response = await conn.request(
      `/studies/${encodeURIComponent(nctId)}?format=json`
    ) as ClinicalTrialsDetailResponse;
    
    const outcomesModule = response.studies?.[0]?.protocolSection?.outcomesModule;
    
    if (!outcomesModule) return {};
    
    const primaryArr: Array<{ measure?: string; timeframe?: string }> = [];
    const secondaryArr: Array<{ measure?: string; timeframe?: string }> = [];
    
    if (outcomesModule.primaryOutcomes) {
      for (const o of outcomesModule.primaryOutcomes) {
        primaryArr.push({ measure: o.measure, timeframe: o.timeframe });
      }
    }
    if (outcomesModule.secondaryOutcomes) {
      for (const o of outcomesModule.secondaryOutcomes) {
        secondaryArr.push({ measure: o.measure, timeframe: o.timeframe });
      }
    }
    
    return { primary: primaryArr, secondary: secondaryArr };
  } catch {
    return {};
  }
}

interface ClinicalTrialsSearchResponse {
  studies?: Array<{
    protocolSection?: {
      identModule?: {
        nctId?: string;
        briefTitle?: string;
        sponsors?: Array<{ name: string }>;
      };
      statusModule?: {
        overallStatus?: string;
        phases?: string[];
      };
      descModule?: {
        conditions?: string[];
      };
      armsModule?: {
        interventions?: Array<{ type: string; name: string }>;
      };
    };
  }>;
}

interface ClinicalTrialsDetailResponse {
  studies?: Array<{
    protocolSection?: {
      identModule?: {
        nctId?: string;
        briefTitle?: string;
        shortTitle?: string;
        sponsors?: Array<{ name: string }>;
        collaborators?: Array<{ name: string }>;
      };
      statusModule?: {
        overallStatus?: string;
        phases?: string[];
      };
      descModule?: {
        conditions?: string[];
        briefSummary?: string;
      };
      armsModule?: {
        interventions?: Array<{ type: string; name: string }>;
      };
      contactsModule?: {
        contacts?: Array<{ role?: string; name?: string; phone?: string; email?: string }>;
        locations?: Array<{ facility?: string; city?: string; state?: string; country?: string; zip?: string; status?: string }>;
      };
      eligModule?: {
        eligibilityCriteria?: string;
        minimumAge?: string;
        maximumAge?: string;
        sex?: string;
        healthyVolunteers?: boolean;
      };
      outcomesModule?: {
        primaryOutcomes?: Array<{ measure?: string; timeframe?: string }>;
        secondaryOutcomes?: Array<{ measure?: string; timeframe?: string }>;
      };
    };
  }>;
}

function transformTrialSearchResult(trial: ClinicalTrialsSearchStudy): TrialSearchResult {
  const identModule = trial.protocolSection?.identModule;
  const statusModule = trial.protocolSection?.statusModule;
  const descModule = trial.protocolSection?.descModule;
  const armsModule = trial.protocolSection?.armsModule;
  
  return {
    nct_id: identModule?.nctId || '',
    title: identModule?.briefTitle,
    status: statusModule?.overallStatus,
    phase: statusModule?.phases?.[0],
    conditions: descModule?.conditions,
    interventions: armsModule?.interventions?.map((i: { type: string; name: string }) => `${i.type}: ${i.name}`),
    sponsor: identModule?.sponsors?.[0]?.name,
  };
}

export function transformTrialResponse(data: ClinicalTrialsDetailStudy): TrialResult {
  return {
    nct_id: data.protocolSection?.identModule?.nctId || '',
    title: data.protocolSection?.identModule?.briefTitle,
    status: data.protocolSection?.statusModule?.overallStatus,
    phase: data.protocolSection?.statusModule?.phases?.[0],
  };
}

interface ClinicalTrialsSearchStudy {
  protocolSection?: {
    identModule?: {
      nctId?: string;
      briefTitle?: string;
      sponsors?: Array<{ name: string }>;
    };
    statusModule?: {
      overallStatus?: string;
      phases?: string[];
    };
    descModule?: {
      conditions?: string[];
    };
    armsModule?: {
      interventions?: Array<{ type: string; name: string }>;
    };
  };
}

interface ClinicalTrialsDetailStudy {
  protocolSection?: {
    identModule?: {
      nctId?: string;
      briefTitle?: string;
      shortTitle?: string;
      sponsors?: Array<{ name: string }>;
      collaborators?: Array<{ name: string }>;
    };
    statusModule?: {
      overallStatus?: string;
      phases?: string[];
    };
    descModule?: {
      conditions?: string[];
      briefSummary?: string;
    };
    armsModule?: {
      interventions?: Array<{ type: string; name: string }>;
    };
    contactsModule?: {
      contacts?: Array<{ role?: string; name?: string; phone?: string; email?: string }>;
      locations?: Array<{ facility?: string; city?: string; state?: string; country?: string; zip?: string; status?: string }>;
    };
    eligModule?: {
      eligibilityCriteria?: string;
      minimumAge?: string;
      maximumAge?: string;
      sex?: string;
      healthyVolunteers?: boolean;
    };
    outcomesModule?: {
      primaryOutcomes?: Array<{ measure?: string; timeframe?: string }>;
      secondaryOutcomes?: Array<{ measure?: string; timeframe?: string }>;
    };
  };
}