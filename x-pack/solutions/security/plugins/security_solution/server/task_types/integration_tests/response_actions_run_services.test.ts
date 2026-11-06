/**
 * @jest-environment node
 */

/* eslint-disable @kbn/eslint/require-license-header */
/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { kibanaPackageJson } from '@kbn/repo-info';
import type { Client } from '@elastic/elasticsearch';
import { createTestServers } from '@kbn/core-test-helpers-kbn-server';
import type { TestElasticsearchUtils } from '@kbn/core-test-helpers-kbn-server';
import { elasticsearchConfigFromEnv } from '@kbn/task-manager-plugin/server/task_process/es_config';
import { startTaskProcessCore } from '@kbn/task-manager-plugin/server/task_process/core_process';
import type { TaskTypeModule } from '@kbn/task-manager-plugin/server/task_type_module';
import { config as fleetConfig } from '@kbn/fleet-plugin/server/config';
import {
  createFleetRunServices,
  getFleetRunEncryptedSavedObjectTypes,
  getFleetRunSavedObjectTypes,
  startFleetRunAppContext,
} from '@kbn/fleet-plugin/server/services/run_time';
import {
  createOsqueryActionService,
  getOsqueryRunSavedObjectTypes,
} from '@kbn/osquery-plugin/server/run_time/create_osquery_action_service';
import { createMockConfig } from '../../config.mock';
import {
  createEndpointResponseActionsRunServices,
  getEndpointResponseActionsRunSavedObjectTypes,
} from '../../endpoint/run_time/create_endpoint_response_actions_run_services';

const KIBANA_VERSION = kibanaPackageJson.version;
const ENCRYPTION_KEY = 'a'.repeat(32);
const AGENT_ID = 'endpoint-agent-1';
const AGENT_POLICY_ID = 'agent-policy-1';
const PACKAGE_POLICY_ID = 'endpoint-package-policy-1';
const RULE_ID = 'rule-1';
const ALERT_ID = 'alert-1';

/**
 * Builds the Fleet, osquery and endpoint response action services the way a task process does, from
 * the task host of Core booted in this process, against a real Elasticsearch, and sends the
 * isolate response action of a rule: the Fleet action and the endpoint action request are written.
 */
describe('the response action services built from a task host', () => {
  let esServer: TestElasticsearchUtils;
  let es: Client;
  let core: Awaited<ReturnType<typeof startTaskProcessCore>>;

  const experimentalFeatures = createMockConfig().experimentalFeatures;
  const types = [
    ...getFleetRunSavedObjectTypes(),
    ...getOsqueryRunSavedObjectTypes(),
    ...getEndpointResponseActionsRunSavedObjectTypes(experimentalFeatures),
  ];
  const module: TaskTypeModule = {
    type: 'test:response-actions',
    title: 'response actions services',
    savedObjectTypes: types,
    encryptedSavedObjectTypes: getFleetRunEncryptedSavedObjectTypes(),
    licensing: true,
    createTaskRunner: () => ({ run: async () => ({ state: {} }), cancel: async () => {} }),
  };

  beforeAll(async () => {
    const { startES } = createTestServers({
      adjustTimeout: (t) => jest.setTimeout(t),
      settings: { es: { license: 'trial' } },
    });
    esServer = await startES();
    es = esServer.es.getClient();

    // The indices and aliases Kibana's migrator would have created for the saved object types.
    const indexMappings = new Map<string, Record<string, unknown>>();
    for (const type of types) {
      const index = type.indexPattern ?? '.kibana';
      indexMappings.set(index, {
        ...(indexMappings.get(index) ?? {}),
        [type.name]: type.mappings,
      });
    }
    for (const [index, properties] of indexMappings) {
      await es.indices.create({
        index: `${index}_${KIBANA_VERSION}_001`,
        aliases: { [index]: {}, [`${index}_${KIBANA_VERSION}`]: {} },
        mappings: {
          dynamic: false,
          properties: {
            type: { type: 'keyword' },
            namespace: { type: 'keyword' },
            namespaces: { type: 'keyword' },
            updated_at: { type: 'date' },
            references: {
              type: 'nested',
              properties: {
                name: { type: 'keyword' },
                type: { type: 'keyword' },
                id: { type: 'keyword' },
              },
            },
            ...Object.fromEntries(
              Object.entries(properties).map(([name, mapping]) => [
                name,
                (mapping as { properties?: unknown })?.properties
                  ? { properties: (mapping as { properties: unknown }).properties }
                  : mapping,
              ])
            ),
          },
        } as never,
      });
    }

    core = await startTaskProcessCore({
      init: {
        kind: 'init',
        elasticsearch: elasticsearchConfigFromEnv({
          ES_URL: esServer.hosts[0],
          ES_USERNAME: esServer.username,
          ES_PASSWORD: esServer.password,
        }),
        kibanaVersion: KIBANA_VERSION,
        authToken: '',
        server: { uuid: '5b2de169-2785-441b-ae8c-186a1936b17d', buildNum: 1, isServerless: false },
        encryptedSavedObjects: { encryptionKey: ENCRYPTION_KEY, decryptionOnlyKeys: [] },
        settings: {} as never,
      },
      module,
    });

    // What Fleet and the Endpoint metadata hold for an enrolled Elastic Defend host.
    const soClient = core.host.savedObjects.getUnsafeInternalClient({
      includedHiddenTypes: ['ingest-agent-policies', 'ingest-package-policies'],
    });
    await soClient.create(
      'ingest-agent-policies',
      {
        name: 'policy',
        namespace: 'default',
        status: 'active',
        is_managed: false,
        revision: 1,
        updated_at: new Date().toISOString(),
        updated_by: 'elastic',
      },
      { id: AGENT_POLICY_ID }
    );
    await soClient.create(
      'ingest-package-policies',
      {
        name: 'endpoint-1',
        namespace: 'default',
        enabled: true,
        policy_id: AGENT_POLICY_ID,
        policy_ids: [AGENT_POLICY_ID],
        package: { name: 'endpoint', title: 'Elastic Defend', version: '9.0.0' },
        inputs: [],
        revision: 1,
        created_at: new Date().toISOString(),
        created_by: 'elastic',
        updated_at: new Date().toISOString(),
        updated_by: 'elastic',
      },
      { id: PACKAGE_POLICY_ID }
    );
    await es.index({
      index: '.fleet-agents',
      id: AGENT_ID,
      refresh: 'wait_for',
      document: {
        active: true,
        policy_id: AGENT_POLICY_ID,
        type: 'PERMANENT',
        enrolled_at: new Date().toISOString(),
        agent: { id: AGENT_ID, version: '9.0.0' },
        local_metadata: { host: { hostname: 'host-1' }, elastic: { agent: { version: '9.0.0' } } },
      },
    });
    // The data streams of the Elastic Defend package, which Kibana installs.
    await es.indices.putIndexTemplate({
      name: 'test-endpoint-actions',
      index_patterns: ['.logs-endpoint.actions-*'],
      data_stream: { hidden: true },
      priority: 200,
      template: {
        mappings: {
          properties: {
            '@timestamp': { type: 'date' },
            originSpaceId: { type: 'keyword' },
            tags: { type: 'keyword' },
            agent: {
              properties: {
                id: { type: 'keyword' },
                policy: {
                  properties: {
                    agentId: { type: 'keyword' },
                    elasticAgentId: { type: 'keyword' },
                    integrationPolicyId: { type: 'keyword' },
                    agentPolicyId: { type: 'keyword' },
                  },
                },
              },
            },
          },
        },
      },
    });
    await es.indices.putIndexTemplate({
      name: 'test-endpoint-action-responses',
      index_patterns: ['.logs-endpoint.action.responses-*'],
      data_stream: { hidden: true },
      priority: 200,
      template: { mappings: { properties: { '@timestamp': { type: 'date' } } } },
    });
    await es.indices.create({
      index: 'metrics-endpoint.metadata_current_default',
      mappings: {
        properties: {
          '@timestamp': { type: 'date' },
          event: { properties: { created: { type: 'date' } } },
          agent: { properties: { id: { type: 'keyword' }, version: { type: 'keyword' } } },
          elastic: { properties: { agent: { properties: { id: { type: 'keyword' } } } } },
          HostDetails: {
            properties: { agent: { properties: { id: { type: 'keyword' } } } },
          },
          host: { properties: { hostname: { type: 'keyword' }, name: { type: 'keyword' } } },
        },
      },
    });
    await es.index({
      index: 'metrics-endpoint.metadata_current_default',
      refresh: 'wait_for',
      document: {
        '@timestamp': new Date().toISOString(),
        event: { created: new Date().toISOString() },
        agent: { id: AGENT_ID, version: '9.0.0' },
        elastic: { agent: { id: AGENT_ID } },
        host: { hostname: 'host-1', name: 'host-1' },
        Endpoint: { capabilities: [], status: 'enrolled' },
      },
    });
  });

  afterAll(async () => {
    await core?.stop();
    await esServer?.stop();
  });

  it('sends the isolate response action of a rule through Fleet and the endpoint index', async () => {
    const { host } = core;
    const license$ = host.licensing!.license$;
    const encryptedSavedObjects = host.encryptedSavedObjects!;

    const fleetConfigValue = fleetConfig.schema.validate({});
    const fleetDeps = {
      elasticsearch: host.elasticsearch,
      savedObjects: host.savedObjects,
      encryptedSavedObjects,
      loggerFactory: { get: (...parts: string[]) => host.logger.get(...parts) } as never,
    };
    await startFleetRunAppContext({
      ...fleetDeps,
      config: fleetConfigValue as never,
      license$,
      audit: host.security.audit as never,
      kibanaVersion: KIBANA_VERSION,
      kibanaBranch: 'main',
      kibanaInstanceId: host.server.uuid,
      isProductionMode: false,
    });
    const fleetRunServices = createFleetRunServices(fleetDeps);

    const osqueryActionService = await createOsqueryActionService({
      fleetRunServices,
      elasticsearch: host.elasticsearch,
      savedObjects: host.savedObjects,
      license$,
      loggerFactory: fleetDeps.loggerFactory,
      analytics: host.analytics,
    });

    const { scheduleNotificationResponseActionsService, stop } =
      await createEndpointResponseActionsRunServices({
        fleetRunServices,
        elasticsearch: host.elasticsearch,
        savedObjects: host.savedObjects,
        license$,
        config: createMockConfig(),
        experimentalFeatures,
        loggerFactory: fleetDeps.loggerFactory,
        analytics: host.analytics,
        security: host.security,
        featureUsage: host.licensing!.featureUsage,
        osqueryActionService,
      });

    await scheduleNotificationResponseActionsService({
      signals: [
        {
          _id: ALERT_ID,
          _index: '.alerts-security.alerts-default',
          agent: { id: AGENT_ID, name: 'host-1', type: 'endpoint' },
          host: { name: 'host-1' },
          kibana: {
            alert: { rule: { uuid: RULE_ID, name: 'my rule' } },
            space_ids: ['default'],
          },
        },
      ],
      signalsCount: 1,
      responseActions: [
        { actionTypeId: '.endpoint', params: { command: 'isolate', comment: 'from a rule' } },
      ],
    } as never);

    await es.indices.refresh({ index: ['.fleet-actions*', '.logs-endpoint.actions-default'] });

    const fleetActions = await es.search({
      index: '.fleet-actions*',
      query: { term: { input_type: 'endpoint' } },
    });
    expect(fleetActions.hits.hits).toHaveLength(1);
    expect(fleetActions.hits.hits[0]._source).toEqual(
      expect.objectContaining({
        agents: [AGENT_ID],
        type: 'INPUT_ACTION',
        data: expect.objectContaining({ command: 'isolate' }),
        signed: expect.objectContaining({
          data: expect.any(String),
          signature: expect.any(String),
        }),
      })
    );

    const requests = await es.search({
      index: '.logs-endpoint.actions-default',
      query: { match_all: {} },
    });
    expect(requests.hits.hits).toHaveLength(1);
    expect(requests.hits.hits[0]._source).toEqual(
      expect.objectContaining({
        agent: expect.objectContaining({ id: [AGENT_ID] }),
        rule: { id: RULE_ID, name: 'my rule' },
        EndpointActions: expect.objectContaining({
          data: expect.objectContaining({ command: 'isolate', comment: 'from a rule' }),
        }),
      })
    );
    expect((requests.hits.hits[0]._source as { error?: unknown }).error).toBeUndefined();

    stop();
    osqueryActionService.stop();
  });
});
