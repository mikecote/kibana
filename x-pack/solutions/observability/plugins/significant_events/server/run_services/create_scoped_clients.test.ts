/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { coreMock, httpServerMock } from '@kbn/core/server/mocks';
import { brandSpaceId } from '@kbn/core-spaces-common';
import { loggerMock } from '@kbn/logging-mocks';
import { inferenceMock } from '@kbn/inference-plugin/server/mocks';
import { fieldsMetadataPluginServerMock } from '@kbn/fields-metadata-plugin/server/mocks';
import { licensingMock } from '@kbn/licensing-plugin/server/mocks';
import { licenseMock } from '@kbn/licensing-plugin/common/licensing.mock';
import { PROJECT_ROUTING_ALL } from '@kbn/cps-server-utils';
import type { NightshiftSource } from '@kbn/nightshift-shared';
import type { SignificantEventsKIsOnboardingClient } from '../lib/workflows/onboarding_workflow_client';
import { createSignificantEventsServices } from '../lib/significant_events/significant_events_clients';
import { createSignificantEventsScopedClients } from './create_scoped_clients';

const source: NightshiftSource = {
  id: 'orders',
  title: 'Orders',
  description: undefined,
  tags: [],
  type: 'logs',
  esql: 'FROM logs-orders-*',
  slug: 'orders',
  view_name: 'orders',
  enabled: true,
  created_by: 'analyst',
  created_at: '2026-11-07T00:00:00.000Z',
  updated_at: '2026-11-07T00:00:00.000Z',
  esql_updated_at: '2026-11-07T00:00:00.000Z',
};

const create = () => {
  const core = coreMock.createStart();
  const logger = loggerMock.create();
  const licensing = licensingMock.createStart();
  licensing.getLicense.mockResolvedValue(
    licenseMock.createLicense({
      features: { security: { isAvailable: true, isEnabled: true } },
    })
  );
  const getSourcesClient = jest.fn().mockResolvedValue({});
  const getAlertEventsClientWithRequest = jest.fn().mockResolvedValue({});
  const getRulesClientWithRequestInSpace = jest.fn().mockResolvedValue({});
  const knowledgeIndicatorService = { getClient: jest.fn().mockResolvedValue({}) };
  const maintenance = { getState: jest.fn().mockResolvedValue('enabled') };
  const run = jest.fn().mockResolvedValue('onboarding-execution');
  let onboarding: Pick<SignificantEventsKIsOnboardingClient, 'run'> | undefined;
  const getStartServices = jest.fn(async () => ({
    coreStart: core,
    pluginsStart: {
      inference: inferenceMock.createStartContract(),
      licensing,
      fieldsMetadata: fieldsMetadataPluginServerMock.createStartContract(),
      nightshiftSources: { getSourcesClient },
      alertingVTwo: { getAlertEventsClientWithRequest, getRulesClientWithRequestInSpace },
    },
  }));
  const getScopedClients = createSignificantEventsScopedClients({
    getStartServices,
    getCpsEnabled: () => true,
    significantEventsServices: createSignificantEventsServices(),
    knowledgeIndicatorService,
    getOnboardingClient: () => onboarding,
    getMaintenanceService: () => maintenance,
    logger,
  });
  return {
    core,
    getStartServices,
    getScopedClients,
    getSourcesClient,
    getAlertEventsClientWithRequest,
    getRulesClientWithRequestInSpace,
    knowledgeIndicatorService,
    maintenance,
    run,
    enableOnboarding: () => {
      onboarding = { run };
    },
  };
};

describe('significant events scoped execution clients', () => {
  it('keeps owned data in the origin project and source reads across linked projects', async () => {
    const fixture = create();
    expect(fixture.getStartServices).not.toHaveBeenCalled();
    const request = httpServerMock.createKibanaRequest({ spaceId: brandSpaceId('finance') });
    const scoped = await fixture.getScopedClients({ request });
    expect(scoped.space).toBe('finance');
    expect(scoped.isSecurityEnabled).toBe(true);
    expect(fixture.core.savedObjects.getScopedClient).toHaveBeenCalledWith(request);
    expect(fixture.core.elasticsearch.client.asScoped).toHaveBeenCalledWith(request);
    expect(fixture.core.elasticsearch.client.asScoped).toHaveBeenCalledWith(request, {
      projectRouting: 'expression',
      value: PROJECT_ROUTING_ALL,
    });
    expect(fixture.getSourcesClient).toHaveBeenCalledWith({ request });
  });

  it('shares lazy clients within a request and separates identities and spaces', async () => {
    const fixture = create();
    for (const spaceId of ['finance', 'sales']) {
      const request = httpServerMock.createKibanaRequest({ spaceId: brandSpaceId(spaceId) });
      const scoped = await fixture.getScopedClients({ request });
      const [first, second] = await Promise.all([
        scoped.getKnowledgeIndicatorClient(),
        scoped.getKnowledgeIndicatorClient(),
      ]);
      expect(first).toBe(second);
      await Promise.all([scoped.getAlertEventsClient(), scoped.getAlertEventsClient()]);
      expect(fixture.getRulesClientWithRequestInSpace).toHaveBeenCalledWith(request, spaceId, {
        app: 'nightshift',
      });
      expect(fixture.knowledgeIndicatorService.getClient).toHaveBeenCalledWith(
        expect.objectContaining({
          space: spaceId,
          esClient: fixture.core.elasticsearch.client.asScoped(request).asInternalUser,
          withSourceWrite: expect.any(Function),
        })
      );
    }
    expect(fixture.getAlertEventsClientWithRequest).toHaveBeenCalledTimes(2);
    expect(fixture.getRulesClientWithRequestInSpace).toHaveBeenCalledTimes(2);
    expect(fixture.knowledgeIndicatorService.getClient).toHaveBeenCalledTimes(2);
  });

  it('resolves onboarding after startup and honors pause and source enablement', async () => {
    const fixture = create();
    const request = httpServerMock.createKibanaRequest({ spaceId: brandSpaceId('finance') });
    const scoped = await fixture.getScopedClients({ request });
    const options = { ignoreContinuousSetting: true };
    await expect(scoped.scheduleSourceOnboarding(source, options)).resolves.toBe(false);
    fixture.enableOnboarding();
    fixture.maintenance.getState.mockResolvedValueOnce('paused');
    await expect(scoped.scheduleSourceOnboarding(source, options)).resolves.toBe(false);
    await expect(
      scoped.scheduleSourceOnboarding({ ...source, enabled: false }, options)
    ).resolves.toBe(false);
    expect(fixture.run).not.toHaveBeenCalled();
    await expect(scoped.scheduleSourceOnboarding(source, options)).resolves.toBe(true);
    expect(fixture.run).toHaveBeenCalledWith({
      request,
      inputs: expect.objectContaining({
        sourceId: source.id,
        sourceSlug: source.slug,
        sourceRevision: source.esql_updated_at,
        rootTriggeredBy: 'scheduled',
      }),
    });
    expect(fixture.maintenance.getState).toHaveBeenCalledWith({ request });
  });

  it('propagates source authorization errors to the caller', async () => {
    const fixture = create();
    fixture.getSourcesClient.mockRejectedValue(new Error('Forbidden source catalog'));
    await expect(
      fixture.getScopedClients({
        request: httpServerMock.createKibanaRequest({ spaceId: brandSpaceId('finance') }),
      })
    ).rejects.toThrow('Forbidden source catalog');
    expect(fixture.getAlertEventsClientWithRequest).not.toHaveBeenCalled();
  });
});
