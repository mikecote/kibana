/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { httpServerMock } from '@kbn/core/server/mocks';
import { elasticsearchClientMock } from '@kbn/core-elasticsearch-client-server-mocks';
import { securityMock } from '@kbn/security-plugin/server/mocks';
import {
  ALERTS_API_ALL,
  ALERTS_API_READ,
  ALERTS_API_UPDATE_DEPRECATED_PRIVILEGE,
} from '@kbn/security-solution-features/constants';
import { AppClient } from '../../../client';
import { createSecurityAlertsClientFactory } from './create_alerts_client';

const setup = async () => {
  const esClient = elasticsearchClientMock.createElasticsearchClient();
  const security = securityMock.createStart();
  jest
    .spyOn(security.authz.actions.api, 'get')
    .mockImplementation((privilege) => `api:${privilege}`);
  const check = jest.fn().mockResolvedValue({ hasAllRequested: true });
  security.authz.checkPrivilegesDynamicallyWithRequest.mockReturnValue(check);
  const auditLogger = { log: jest.fn(), enabled: true, includeSavedObjectNames: true };
  const eventBus = { emitAlertTagsChanged: jest.fn() };
  const request = httpServerMock.createKibanaRequest();
  const getSearchIndex = jest.fn().mockReturnValue('.alerts-security.alerts-alpha');
  const getAppClient = jest
    .fn()
    .mockReturnValue(
      new AppClient('alpha', { signalsIndex: '.siem-signals' }, '9.6.0', 'main', 'traditional')
    );
  esClient.search.mockResponse({
    took: 1,
    timed_out: false,
    _shards: { total: 1, successful: 1, skipped: 0, failed: 0 },
    hits: { hits: [] },
  });
  esClient.updateByQuery.mockResponse({
    took: 1,
    timed_out: false,
    total: 2,
    updated: 2,
    deleted: 0,
    batches: 1,
    version_conflicts: 0,
    noops: 0,
    retries: { bulk: 0, search: 0 },
    throttled_millis: 0,
    requests_per_second: -1,
    throttled_until_millis: 0,
    failures: [],
  });
  const client = await createSecurityAlertsClientFactory({
    getEsClient: () => esClient,
    getSearchIndex,
    getAppClient,
    getAuditLogger: () => auditLogger,
    getSecurity: async () => security,
    eventBus,
  })(request);
  return { client, esClient, check, auditLogger, eventBus, request, getSearchIndex, getAppClient };
};

describe('native Security alerts client', () => {
  it('uses the owning native index and rechecks API privileges before every search', async () => {
    const { client, esClient, check } = await setup();
    const input = { query: { match_all: {} }, index: 'another-space' };
    await client.search(input);
    expect(check).toHaveBeenCalledWith({ kibana: [`api:${ALERTS_API_READ}`] });
    expect(esClient.search).toHaveBeenCalledWith(
      expect.objectContaining({ index: '.alerts-security.alerts-alpha', query: { match_all: {} } })
    );
    esClient.search.mockClear();
    check.mockResolvedValue({ hasAllRequested: false });
    await expect(client.search(input)).rejects.toMatchObject({ output: { statusCode: 403 } });
    expect(esClient.search).not.toHaveBeenCalled();
  });
  it('rejects a missing owning index before querying Elasticsearch', async () => {
    const { client, esClient, getSearchIndex } = await setup();
    getSearchIndex.mockReturnValue(undefined);
    await expect(client.search({ query: { match_all: {} } })).rejects.toMatchObject({
      output: { statusCode: 503 },
    });
    expect(esClient.search).not.toHaveBeenCalled();
  });
  it('accepts the native deprecated update privilege when the all privilege is absent', async () => {
    const { client, check, esClient } = await setup();
    check.mockImplementation(async ({ kibana }: { kibana: string[] }) => ({
      hasAllRequested: kibana.includes(`api:${ALERTS_API_UPDATE_DEPRECATED_PRIVILEGE}`),
    }));
    await client.updateTags({ ids: ['one'], tags: { tags_to_add: ['new'], tags_to_remove: [] } });
    expect(check).toHaveBeenCalledWith({ kibana: [`api:${ALERTS_API_ALL}`] });
    expect(esClient.updateByQuery).toHaveBeenCalledTimes(1);
  });
  it('validates conflicting tags before any audit intent or mutation', async () => {
    const { client, auditLogger, esClient } = await setup();
    await expect(
      client.updateTags({ ids: ['one'], tags: { tags_to_add: ['same'], tags_to_remove: ['same'] } })
    ).rejects.toMatchObject({ output: { statusCode: 400 } });
    expect(esClient.updateByQuery).not.toHaveBeenCalled();
    expect(auditLogger.log).not.toHaveBeenCalled();
  });
  it('uses the shared observed delta and native audit events for a successful update', async () => {
    const { client, esClient, auditLogger, eventBus, request } = await setup();
    esClient.search.mockResponse({
      took: 1,
      timed_out: false,
      _shards: { total: 1, successful: 1, skipped: 0, failed: 0 },
      hits: {
        hits: [
          {
            _id: 'changed',
            _index: '.alerts-security.alerts-alpha',
            _source: { 'kibana.alert.workflow_tags': ['old'] },
          },
          {
            _id: 'unchanged',
            _index: '.alerts-security.alerts-alpha',
            _source: { 'kibana.alert.workflow_tags': ['new'] },
          },
        ],
      },
    });
    await client.updateTags({
      ids: ['changed', 'unchanged'],
      tags: { tags_to_add: ['new'], tags_to_remove: ['old'] },
    });
    expect(esClient.updateByQuery).toHaveBeenCalledWith(
      expect.objectContaining({ index: '.alerts-security.alerts-alpha' })
    );
    expect(auditLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({ action: 'alert_update', outcome: 'unknown' }),
      })
    );
    expect(eventBus.emitAlertTagsChanged).toHaveBeenCalledWith(request, {
      alertIds: ['changed'],
      tagsAdded: ['new'],
      tagsRemoved: ['old'],
      truncated: false,
    });
  });
  it('audits a failed native write and emits no successful change event', async () => {
    const { client, esClient, auditLogger, eventBus } = await setup();
    esClient.updateByQuery.mockRejectedValue(new Error('Write failed'));
    await expect(
      client.updateTags({ ids: ['one'], tags: { tags_to_add: ['new'], tags_to_remove: [] } })
    ).rejects.toThrow('Write failed');
    expect(auditLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({ action: 'alert_update', outcome: 'failure' }),
      })
    );
    expect(eventBus.emitAlertTagsChanged).not.toHaveBeenCalled();
  });
});
