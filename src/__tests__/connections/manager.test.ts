import { jest } from '@jest/globals';

jest.mock('../../connections/rest.js', () => ({
  RestConnection: jest.fn<(...args: any[]) => any>().mockImplementation((config: any) => ({
    sourceId: config.sourceId,
    protocol: 'rest',
    effectiveRateLimitMs: 100,
    request: jest.fn<(...args: any[]) => any>().mockResolvedValue({}),
    healthCheck: jest.fn<(...args: any[]) => any>().mockResolvedValue(true),
    close: jest.fn<(...args: any[]) => any>(),
    batch: jest.fn<(...args: any[]) => any>().mockResolvedValue([]),
  })),
}));

jest.mock('../../connections/graphql.js', () => ({
  GraphQLConnection: jest.fn<(...args: any[]) => any>().mockImplementation((config: any) => ({
    sourceId: config.sourceId,
    protocol: 'graphql',
    effectiveRateLimitMs: 100,
    request: jest.fn<(...args: any[]) => any>().mockResolvedValue({}),
    healthCheck: jest.fn<(...args: any[]) => any>().mockResolvedValue(true),
    close: jest.fn<(...args: any[]) => any>(),
    batch: jest.fn<(...args: any[]) => any>().mockResolvedValue([]),
  })),
}));

jest.mock('../../connections/registry.js', () => ({
  SOURCE_REGISTRY: {
    mygene: { sourceId: 'mygene', baseUrl: 'https://mygene.info/v3', protocol: 'rest', rateLimit: { intervalMs: 100 } },
    opentargets: { sourceId: 'opentargets', baseUrl: 'https://api.platform.opentargets.org/api/v4', protocol: 'graphql', rateLimit: { intervalMs: 500 } },
  },
  getSourceConfig: jest.fn<(...args: any[]) => any>().mockImplementation((id: any) => {
    const registry: Record<string, any> = {
      mygene: { sourceId: 'mygene', baseUrl: 'https://mygene.info/v3', protocol: 'rest', rateLimit: { intervalMs: 100 } },
      opentargets: { sourceId: 'opentargets', baseUrl: 'https://api.platform.opentargets.org/api/v4', protocol: 'graphql', rateLimit: { intervalMs: 500 } },
    };
    return registry[id];
  }),
}));

import { ConnectionManager } from '../../connections/manager.js';

describe('ConnectionManager', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('getConnection("mygene") returns RestConnection', () => {
    const manager = new ConnectionManager();
    const conn = manager.getConnection('mygene');
    expect(conn.protocol).toBe('rest');
    expect(conn.sourceId).toBe('mygene');
  });

  test('getConnection("opentargets") returns GraphQLConnection', () => {
    const manager = new ConnectionManager();
    const conn = manager.getConnection('opentargets');
    expect(conn.protocol).toBe('graphql');
    expect(conn.sourceId).toBe('opentargets');
  });
});
