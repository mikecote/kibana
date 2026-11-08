/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { of } from 'rxjs';
import { elasticsearchServiceMock } from '@kbn/core-elasticsearch-server-mocks';
import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import { savedObjectsServiceMock } from '@kbn/core-saved-objects-server-mocks';
import { securityServiceMock } from '@kbn/core-security-server-mocks';
import { httpServerMock } from '@kbn/core-http-server-mocks';
import type { ILicense } from '@kbn/licensing-types';
import { createFleetStartContractMock } from '@kbn/fleet-plugin/server/mocks';
import { dataPluginMock } from '@kbn/data-plugin/server/mocks';
import { spacesMock } from '@kbn/spaces-plugin/server/mocks';
import { ProductFeatureKey } from '@kbn/security-solution-features/keys';
import { TelemetryConfigProvider } from '../../../common/telemetry_config/telemetry_config_provider';
import { createNativeProductFeaturesReader } from '../../lib/product_features_service';

import { allowedExperimentalValues } from '../../../common/experimental_features';
import {
  EndpointAppContentServicesKibanaOnlyError,
  EndpointAppContentServicesNotStartedError,
} from '../errors';
import {
  createEndpointResponseActionsRunServices,
  getEndpointResponseActionsRunSavedObjectTypes,
} from './create_endpoint_response_actions_run_services';

const enterpriseLicense = {
  isActive: true,
  isAvailable: true,
  type: 'enterprise',
  hasAtLeast: () => true,
} as unknown as ILicense;

describe('createEndpointResponseActionsRunServices', () => {
  const build = async (
    overrides: Partial<Parameters<typeof createEndpointResponseActionsRunServices>[0]> = {}
  ) => {
    const fleet = createFleetStartContractMock();
    fleet.agentService.asInternalScopedUser.mockReturnValue(fleet.agentService.asInternalUser);
    // What a task process has of Fleet: no files client, no authz, no callbacks
    const {
      agentService,
      packageService,
      agentPolicyService,
      packagePolicyService,
      messageSigningService,
      createFleetActionsClient,
    } = fleet;
    const elasticsearch = elasticsearchServiceMock.createStart();
    const featureUsage = { notifyUsage: jest.fn() };
    const deps = {
      fleetRunServices: {
        agentService,
        packageService,
        agentPolicyService,
        packagePolicyService,
        messageSigningService,
        createFleetActionsClient,
      },
      elasticsearch: elasticsearch.client,
      savedObjects: savedObjectsServiceMock.createStartContract(),
      license$: of(enterpriseLicense),
      config: { maxUploadResponseActionFileBytes: 1000, maxEndpointScriptFileSize: 2000 },
      experimentalFeatures: { ...allowedExperimentalValues },
      loggerFactory: loggingSystemMock.create(),
      analytics: { reportEvent: jest.fn() },
      security: securityServiceMock.createStart(),
      featureUsage,
      ...overrides,
    };

    return {
      fleet,
      elasticsearch,
      featureUsage,
      deps,
      services: await createEndpointResponseActionsRunServices(deps),
    };
  };

  it('returns the endpoint app context service wired to the dependencies it was given', async () => {
    const { services, elasticsearch, fleet, deps } = await build();
    const { endpointAppContextService: endpoint } = services;

    expect(endpoint.getInternalEsClient()).toBe(elasticsearch.client.asInternalUser);
    expect(endpoint.getLicenseService().isEnterprise()).toBe(true);
    expect(endpoint.experimentalFeatures).toBe(deps.experimentalFeatures);
    expect(endpoint.getMessageSigningService()).toBe(fleet.messageSigningService);
    expect(endpoint.getServerConfigValue('maxEndpointScriptFileSize')).toBe(2000);
    expect(endpoint.getInternalFleetServices('default').agent).toBe(
      fleet.agentService.asInternalUser
    );

    await endpoint.getFleetActionsClient();
    expect(fleet.createFleetActionsClient).toHaveBeenCalledWith('endpoint');
    expect(endpoint.getTelemetryService()).toBe(deps.analytics);
    expect(endpoint.createLogger('a')).toBeDefined();
    services.stop();
  });

  it('reports the feature usage of response actions through the host', async () => {
    const { services, featureUsage } = await build();

    services.endpointAppContextService.getFeatureUsageService().notifyUsage('HOST_ISOLATION');

    expect(featureUsage.notifyUsage).toHaveBeenCalledWith('Host isolation');
    services.stop();
  });

  it('uses native execution dependencies for request routing and policy gates', async () => {
    const clusterClient = elasticsearchServiceMock.createStart().client;
    const dataStart = dataPluginMock.createStartContract();
    const spacesService = spacesMock.createStart().spacesService;
    const telemetryConfigProvider = new TelemetryConfigProvider(true);
    const productFeaturesService = createNativeProductFeaturesReader({
      enabledProductFeatureKeys: [ProductFeatureKey.graphVisualization],
      registeredActions: [],
    });
    const isCpsActive = jest.fn().mockResolvedValue(true);
    const { services } = await build({
      cloud: { isCloudEnabled: true, isServerlessEnabled: false },
      executionServices: {
        clusterClient,
        dataStart,
        spacesService,
        telemetryConfigProvider,
        productFeaturesService,
        isCpsActive,
      },
    });
    const endpoint = services.endpointAppContextService;
    const request = httpServerMock.createKibanaRequest();
    await endpoint.getScopedSearchClient(request);
    expect(dataStart.search.asScoped).toHaveBeenLastCalledWith(request, {
      projectRouting: 'space',
    });
    expect(await endpoint.getReadEsClient(request)).toBe(clusterClient.asScoped().asCurrentUser);
    expect(
      endpoint.getProductFeaturesService().isEnabled(ProductFeatureKey.graphVisualization)
    ).toBe(true);
    expect(endpoint.getTelemetryConfigProvider().getIsOptedIn()).toBe(true);
    expect(endpoint.getCloudSetup().isCloudEnabled).toBe(true);

    isCpsActive.mockResolvedValue(false);
    await endpoint.getScopedSearchClient(request);
    expect(dataStart.search.asScoped).toHaveBeenLastCalledWith(request);
    expect(await endpoint.getReadEsClient(request)).toBe(endpoint.getInternalEsClient());
    services.stop();
  });

  it('does not fail when the host has no feature usage', async () => {
    const { services } = await build({ featureUsage: undefined });

    expect(() =>
      services.endpointAppContextService.getFeatureUsageService().notifyUsage('HOST_ISOLATION')
    ).not.toThrow();
    services.stop();
  });

  it('registers nothing with Fleet or the lists plugin', async () => {
    const { fleet } = await build();

    expect(fleet.registerExternalCallback).not.toHaveBeenCalled();
  });

  it('throws a clear error for what only Kibana has', async () => {
    const { services } = await build();
    const endpoint = services.endpointAppContextService;
    const request = httpServerMock.createKibanaRequest();

    expect(() => endpoint.getProductFeaturesService()).toThrow(
      EndpointAppContentServicesKibanaOnlyError
    );
    await expect(endpoint.getRulesClient(request)).rejects.toThrow(
      EndpointAppContentServicesKibanaOnlyError
    );
    await expect(endpoint.getFleetToHostFilesClient()).rejects.toThrow(
      EndpointAppContentServicesKibanaOnlyError
    );
    expect(() => endpoint.getCloudSetup()).toThrow(EndpointAppContentServicesKibanaOnlyError);
    expect(() => endpoint.getTelemetryConfigProvider()).toThrow(/available in Kibana only/);
    services.stop();
  });

  it('gives the response actions of 3rd party EDRs a connector client that fails clearly', async () => {
    const { services } = await build();

    const client = services.endpointAppContextService.getInternalResponseActionsClient({
      agentType: 'sentinel_one',
      spaceId: 'default',
    });

    await expect(client.isolate({ endpoint_ids: ['a'] })).rejects.toThrow(
      /available in Kibana only/
    );
    services.stop();
  });

  it('stops using the services after stop()', async () => {
    const { services } = await build();

    services.stop();

    expect(() => services.endpointAppContextService.getLicenseService()).toThrow(
      EndpointAppContentServicesNotStartedError
    );
  });

  it('returns the service that schedules the response actions of a rule', async () => {
    const { services } = await build();

    // No alerts to act on, so there is nothing to await and nothing to write
    await expect(
      services.scheduleNotificationResponseActionsService({
        signals: [],
        signalsCount: 0,
        responseActions: [],
      })
    ).resolves.toBeUndefined();
    services.stop();
  });

  it('lists the saved object types the response actions use', () => {
    expect(
      getEndpointResponseActionsRunSavedObjectTypes({
        responseActionsScriptLibraryManagement: false,
      }).map(({ name }) => name)
    ).toEqual(['security:reference-data']);
    expect(
      getEndpointResponseActionsRunSavedObjectTypes({
        responseActionsScriptLibraryManagement: true,
      }).map(({ name }) => name)
    ).toEqual(['security:reference-data', 'security:endpoint-scripts-library']);
  });
});
