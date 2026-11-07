/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { CoreStart, Logger } from '@kbn/core/server';
import type { AlertEventsClientApi } from '@kbn/alerting-v2-plugin/server';
import type { NightshiftSource } from '@kbn/nightshift-shared';
import { PROJECT_ROUTING_ALL } from '@kbn/cps-server-utils';
import { OBSERVABILITY_NIGHTSHIFT_CONTINUOUS_ONBOARDING_ENABLED } from '@kbn/management-settings-ids';
import type { SignificantEventsPluginStartDependencies } from '../types';
import type { GetScopedClients, IScheduleSourceOnboardingOptions } from '../routes/types';
import type {
  KnowledgeIndicatorClient,
  KnowledgeIndicatorService,
} from '../lib/knowledge_indicators';
import {
  createSourceKnowledgeStateClient,
  SOURCE_KNOWLEDGE_STATE_TYPE,
} from '../lib/knowledge_indicators/source_knowledge_state';
import { getSignificantEventsTuningConfig } from '../lib/significant_events/helpers/get_significant_events_tuning_config';
import { createSignificantEventsAlertingContextResolver } from '../lib/significant_events/alerting/significant_events_alerting_context';
import type { SignificantEventsAlertingContext } from '../lib/significant_events/alerting/significant_events_alerting_context';
import { createSignificantEventsClients } from '../lib/significant_events/significant_events_clients';
import type { createSignificantEventsServices } from '../lib/significant_events/significant_events_clients';
import type { SignificantEventsMaintenanceService } from '../lib/maintenance/maintenance_service';
import type { SignificantEventsKIsOnboardingClient } from '../lib/workflows/onboarding_workflow_client';
import { createTriggerEmitter } from '../workflows/triggers/emit';

interface ScopedClientsDeps {
  getStartServices: () => Promise<{
    coreStart: {
      elasticsearch: { client: Pick<CoreStart['elasticsearch']['client'], 'asScoped'> };
      savedObjects: Pick<CoreStart['savedObjects'], 'getScopedClient' | 'createInternalRepository'>;
      uiSettings: Pick<CoreStart['uiSettings'], 'asScopedToClient' | 'globalAsScopedToClient'>;
      dataStreams: CoreStart['dataStreams'];
    };
    pluginsStart: {
      inference: Pick<SignificantEventsPluginStartDependencies['inference'], 'getClient'>;
      licensing: SignificantEventsPluginStartDependencies['licensing'];
      fieldsMetadata: Pick<SignificantEventsPluginStartDependencies['fieldsMetadata'], 'getClient'>;
      nightshiftSources: Pick<
        SignificantEventsPluginStartDependencies['nightshiftSources'],
        'getSourcesClient'
      >;
      alertingVTwo: Pick<
        SignificantEventsPluginStartDependencies['alertingVTwo'],
        'getAlertEventsClientWithRequest' | 'getRulesClientWithRequestInSpace'
      >;
      workflowsExtensions?: SignificantEventsPluginStartDependencies['workflowsExtensions'];
    };
  }>;
  getCpsEnabled: () => boolean;
  significantEventsServices: ReturnType<typeof createSignificantEventsServices>;
  knowledgeIndicatorService: Pick<KnowledgeIndicatorService, 'getClient'>;
  getOnboardingClient: () => Pick<SignificantEventsKIsOnboardingClient, 'run'> | undefined;
  getMaintenanceService: () => Pick<SignificantEventsMaintenanceService, 'getState'> | undefined;
  logger: Logger;
}

const RULE_CREATION_APP = 'nightshift';

/** Creates the request-scoped significant events clients from their execution services. */
export const createSignificantEventsScopedClients =
  ({
    getStartServices,
    getCpsEnabled,
    significantEventsServices,
    knowledgeIndicatorService,
    getOnboardingClient,
    getMaintenanceService,
    logger,
  }: ScopedClientsDeps): GetScopedClients =>
  async ({ request }) => {
    const { coreStart, pluginsStart } = await getStartServices();
    const cpsEnabled = getCpsEnabled();

    const scopedSoClient = coreStart.savedObjects.getScopedClient(request);
    const uiSettingsClient = coreStart.uiSettings.asScopedToClient(scopedSoClient);
    const globalUiSettingsClient = coreStart.uiSettings.globalAsScopedToClient(scopedSoClient);

    // `scopedClusterClient`: origin-only. Used for everything the plugin owns (its hidden
    // data streams), which only ever exists in the origin project.
    // `streamDataEsClient`: always routed across every CPS-linked project, regardless of the
    // active space's project routing expression. Knowledge indicators are stored per space,
    // but they model all data available to a source, so extraction must always read across
    // every linked project.
    //
    // Detection matches that all-projects scope when CPS is enabled via `withAllProjectsRouting`.
    const scopedClusterClient = coreStart.elasticsearch.client.asScoped(request);
    const streamDataEsClient = coreStart.elasticsearch.client.asScoped(request, {
      projectRouting: 'expression',
      value: PROJECT_ROUTING_ALL,
    }).asCurrentUser;
    const soClient = scopedSoClient;
    const inferenceClient = pluginsStart.inference.getClient({ request });
    const licensing = pluginsStart.licensing;
    const fieldsMetadataClient = await pluginsStart.fieldsMetadata.getClient(request);

    const [tuningConfig, sourcesClient] = await Promise.all([
      getSignificantEventsTuningConfig(globalUiSettingsClient, logger),
      pluginsStart.nightshiftSources.getSourcesClient({ request }),
    ]);

    // Core always populates `request.spaceId` (default space when the URL has no prefix), so
    // no fallback is needed. Knowledge indicators and their rules are scoped to this space.
    const space = request.spaceId;

    let alertEventsClientPromise: Promise<AlertEventsClientApi> | undefined;
    const getAlertEventsClient = (): Promise<AlertEventsClientApi> => {
      alertEventsClientPromise ??=
        pluginsStart.alertingVTwo.getAlertEventsClientWithRequest(request);
      return alertEventsClientPromise;
    };

    const significantEventsClients = createSignificantEventsClients({
      services: significantEventsServices,
      dataStreams: coreStart.dataStreams,
      esClient: scopedClusterClient.asCurrentUser,
      space,
      getAlertEventsClient,
      triggerEmitter: createTriggerEmitter({
        workflowsExtensions: pluginsStart.workflowsExtensions,
        request,
        logger,
      }),
    });

    const getAlertingV2RulesClient = async () =>
      pluginsStart.alertingVTwo.getRulesClientWithRequestInSpace(request, space, {
        app: RULE_CREATION_APP,
      });

    const resolveSignificantEventsAlertingContext = createSignificantEventsAlertingContextResolver({
      getAlertingV2RulesClient,
      cpsEnabled,
    });

    const sourceKnowledgeState = createSourceKnowledgeStateClient({
      repository: coreStart.savedObjects.createInternalRepository([SOURCE_KNOWLEDGE_STATE_TYPE]),
      space,
      sourcesClient,
    });
    const createKnowledgeIndicatorClient = (
      context: SignificantEventsAlertingContext,
      source?: NightshiftSource
    ) =>
      knowledgeIndicatorService.getClient({
        esClient: scopedClusterClient.asInternalUser,
        soClient,
        space,
        context,
        config: tuningConfig,
        withSourceWrite: (sourceId, run, options) =>
          sourceKnowledgeState.write({
            sourceId,
            allowDisabled: options?.allowDisabled,
            expectedRevision:
              typeof request.headers['x-nightshift-source-revision'] === 'string' &&
              request.headers['x-nightshift-source-revision']
                ? request.headers['x-nightshift-source-revision']
                : source?.esql_updated_at,
            run,
          }),
      });

    let kiClientPromise: ReturnType<typeof createKnowledgeIndicatorClient> | undefined;
    const getKnowledgeIndicatorClient = async (
      source?: NightshiftSource
    ): Promise<KnowledgeIndicatorClient> => {
      if (source) {
        return createKnowledgeIndicatorClient(
          await resolveSignificantEventsAlertingContext(),
          source
        );
      }
      kiClientPromise ??= (async () =>
        createKnowledgeIndicatorClient(await resolveSignificantEventsAlertingContext()))();
      return kiClientPromise;
    };

    const license = await licensing.getLicense();
    const isSecurityEnabled = license.getFeature('security').isEnabled;

    return {
      scopedClusterClient,
      streamDataEsClient,
      soClient,
      space,
      getSignificantEventsAlertingContext: resolveSignificantEventsAlertingContext,
      getKnowledgeIndicatorClient,
      sourceKnowledgeState,
      scheduleSourceOnboarding: async (
        source: NightshiftSource,
        { ignoreContinuousSetting = false }: IScheduleSourceOnboardingOptions = {}
      ): Promise<boolean> => {
        const streamsKIsOnboardingClient = getOnboardingClient();
        if (
          !streamsKIsOnboardingClient ||
          !source.enabled ||
          // The toggle governs the periodic sweeps only. A created or edited source is
          // onboarded once for its new revision whatever the toggle says.
          (!ignoreContinuousSetting &&
            !(await uiSettingsClient.get<boolean>(
              OBSERVABILITY_NIGHTSHIFT_CONTINUOUS_ONBOARDING_ENABLED
            ))) ||
          (await getMaintenanceService()?.getState({ request })) === 'paused'
        ) {
          return false;
        }
        const now = Date.now();
        await streamsKIsOnboardingClient.run({
          request,
          inputs: {
            sourceId: source.id,
            sourceSlug: source.slug,
            sourceRevision: source.esql_updated_at,
            rootTriggeredBy: 'scheduled',
            features: {
              skip: false,
              start: now - 24 * 60 * 60_000,
              end: now,
              recencyThresholdHours: 0,
            },
            queries: { skip: false },
          },
        });
        return true;
      },
      getAlertEventsClient,
      ...significantEventsClients,
      inferenceClient,
      fieldsMetadataClient,
      sourcesClient,
      licensing,
      uiSettingsClient,
      globalUiSettingsClient,
      isSecurityEnabled,
      tuningConfig,
    };
  };
