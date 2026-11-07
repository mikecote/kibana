/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { InferenceTaskType } from '@elastic/elasticsearch/lib/api/types';
import type { CoreStart, IClusterClient, KibanaRequest, Logger } from '@kbn/core/server';
import type { BoundInferenceClient, InferenceClient } from '@kbn/inference-common';
import {
  aiAnonymizationSettings,
  parseLegacyAnonymizationRules,
  parseLegacyOnFailureMode,
} from '@kbn/ai-anonymization-common';
import type { AnonymizationFailureMode, AnonymizationRule } from '@kbn/ai-anonymization-common';
import type { RegexWorkerService } from '@kbn/ai-anonymization-server';
import type { AnonymizationPluginStart } from '@kbn/anonymization-plugin/server';
import {
  GEN_AI_SETTINGS_DEFAULT_AI_CONNECTOR_DEFAULT_ONLY,
  GEN_AI_SETTINGS_INFERENCE_STREAMING,
  GEN_AI_SETTINGS_TOKEN_USAGE_TRACKING,
} from '@kbn/management-settings-ids';
import type { InferenceConfig } from './config';
import { createClient as createInferenceClient, createChatModel } from './inference_client';
import { createInferenceRunServices } from './run_services';
import type { TokenUsageLogger } from './token_usage';
import type {
  ActionsClientProvider,
  InferenceBoundClientCreateOptions,
  InferenceClientCreateOptions,
  InferenceServerStart,
} from './types';
import { getConnectorList } from './util/get_connector_list';
import { loadDefaultConnector } from './util/load_default_connector';
import { getConnectorById } from './util/get_connector_by_id';
import { getInferenceEndpoints } from './util/get_inference_endpoints';
import { getInferenceEndpointById } from './util/get_inference_endpoint_by_id';
import type { InferenceEndpointIdCache } from './util/inference_endpoint_id_cache';
import { shouldStreamInferenceEndpoint } from './util/should_stream_inference_endpoint';

/**
 * Resolves the `onFailure` mode from the legacy `ai:anonymizationSettings` read. A failed read
 * resolves to `block`: the rules promise built from the same read already fails the request, and
 * this promise must not reject on its own when nothing awaits it.
 */
export const resolveOnFailureMode = async ({
  anonymizationEnabled,
  legacySettingsPromise,
}: {
  anonymizationEnabled: boolean;
  legacySettingsPromise?: Promise<unknown>;
}): Promise<AnonymizationFailureMode> => {
  // The profile-based path doesn't define a failure-mode concept; keep the safe default.
  if (anonymizationEnabled || !legacySettingsPromise) {
    return 'block';
  }
  try {
    return parseLegacyOnFailureMode(await legacySettingsPromise);
  } catch {
    return 'block';
  }
};

export const resolveReplacementsEncryptionKey = async ({
  namespace,
  anonymizationEnabled,
  policyService,
}: {
  namespace: string;
  anonymizationEnabled: boolean;
  policyService?: {
    getReplacementsEncryptionKey: (targetNamespace: string) => Promise<string>;
  };
}): Promise<string | undefined> => {
  if (!anonymizationEnabled || !policyService) {
    return undefined;
  }

  return policyService.getReplacementsEncryptionKey(namespace);
};

/**
 * Builds the per-request streaming resolver. The space setting is read with the request-scoped
 * saved objects client so it reflects the request's space, while the service capability lookup
 * (`GET _inference/_services`) uses the internal ES client because the user calling chat
 * completion is not expected to hold inference management privileges.
 */
export const createInferenceStreamingResolver = ({
  core,
  logger,
  request,
}: {
  core: Pick<CoreStart, 'elasticsearch' | 'savedObjects' | 'uiSettings'>;
  logger: Logger;
  request: KibanaRequest;
}) => {
  return (service?: string): Promise<boolean> =>
    shouldStreamInferenceEndpoint({
      service,
      esClient: core.elasticsearch.client.asInternalUser,
      isStreamingEnabled: async () => {
        const scopedSavedObjectsClient = core.savedObjects.getScopedClient(request);
        const uiSettingsClient = core.uiSettings.asScopedToClient(scopedSavedObjectsClient);
        return await uiSettingsClient.get<boolean>(GEN_AI_SETTINGS_INFERENCE_STREAMING);
      },
      logger,
    });
};

/** What the inference services read of Core: the plugin hands Core's start contract, a task process its host. */
export interface InferenceServicesCore {
  elasticsearch: Pick<IClusterClient, 'asInternalUser' | 'asScoped'>;
  savedObjects: Pick<CoreStart['savedObjects'], 'getScopedClient'>;
  uiSettings: Pick<CoreStart['uiSettings'], 'asScopedToClient'>;
}

export interface CreateInferenceServicesOptions {
  core: InferenceServicesCore;
  /** Where the connectors come from: the actions plugin's start contract, or what runs in its place. */
  actions: ActionsClientProvider;
  anonymization?: Pick<AnonymizationPluginStart, 'isEnabled' | 'getPolicyService'>;
  logger: Logger;
  /** Only the worker pool of the anonymization, which a process turns off (it has no worker file). */
  config: Pick<InferenceConfig, 'workers'>;
  /** The plugin shares its own instances with the rest of its start contract. */
  regexWorker?: RegexWorkerService;
  endpointIdCache?: InferenceEndpointIdCache;
  tokenUsageLogger: TokenUsageLogger;
}

export interface InferenceServices {
  /** The start contract of the plugin, apart from installing the token usage dashboard. */
  contract: Omit<InferenceServerStart, 'installTokenUsageDashboard'>;
  /** The pool of the anonymization, which its owner stops. */
  regexWorker: RegexWorkerService;
}

/**
 * Builds the inference plugin's start contract, apart from installing the token usage dashboard,
 * from explicit dependencies: the plugin builds it from Core and the actions plugin, and a task
 * process (the `ai.*` workflow steps) from its host. One implementation, so a run behaves as Kibana.
 */
export const createInferenceServices = ({
  core,
  actions,
  anonymization,
  logger,
  config,
  regexWorker,
  endpointIdCache,
  tokenUsageLogger,
}: CreateInferenceServicesOptions): InferenceServices => {
  // Two anonymization implementations coexist here:
  //  - Legacy (live): rules from the `ai:anonymizationSettings` uiSetting, no persisted replacements.
  //  - Policy-service (dormant): profiles, per-space salt and persistent replacements from the
  //    `anonymization` plugin, awaiting removal. The pipeline no longer applies that plugin's
  //    field policies, so re-activating it would NOT mask fields it is configured to mask.
  // `anonymization.isEnabled()` is backed by the hard-coded `ANONYMIZATION_FEATURE_ACTIVE = false`,
  // so this is always false and every `anonymizationEnabled` branch below is dead code. Treat the
  // uiSetting path as the only real one.
  const anonymizationEnabled = anonymization?.isEnabled() ?? false;

  // The services a rule run uses are built by the function a task process builds them with.
  const runServices = createInferenceRunServices({
    actions,
    esClient: core.elasticsearch.asInternalUser,
    logger,
    config,
    regexWorker,
    endpointIdCache,
  });
  const { regexWorker: worker, endpointIdCache: idCache } = runServices;

  const readLegacyAnonymizationSettings = (request: KibanaRequest): Promise<unknown> => {
    const scopedSavedObjectsClient = core.savedObjects.getScopedClient(request);
    const uiSettingsClient = core.uiSettings.asScopedToClient(scopedSavedObjectsClient);
    return uiSettingsClient.get<unknown>(aiAnonymizationSettings);
  };

  const createAnonymizationRulesPromise = async (
    request: KibanaRequest,
    legacySettingsPromise?: Promise<unknown>
  ) => {
    const namespace = core.savedObjects.getScopedClient(request).getCurrentNamespace() ?? 'default';
    const policyService = anonymization?.getPolicyService();

    const getLegacyRules = async (): Promise<AnonymizationRule[]> =>
      parseLegacyAnonymizationRules(
        await (legacySettingsPromise ?? readLegacyAnonymizationSettings(request))
      );

    if (!anonymizationEnabled || !policyService) {
      return getLegacyRules();
    }

    await policyService.ensureGlobalProfile(namespace);
    const globalProfile = await policyService.getGlobalProfile(namespace);
    if (!globalProfile) {
      return [];
    }

    const regexRules: AnonymizationRule[] = globalProfile.rules.regexRules.map((rule) => ({
      type: 'RegExp',
      enabled: rule.enabled,
      pattern: rule.pattern,
      entityClass: rule.entityClass,
    }));
    const nerRules: AnonymizationRule[] = globalProfile.rules.nerRules.map((rule) => ({
      type: 'NER',
      enabled: rule.enabled,
      modelId: rule.modelId,
      allowedEntityClasses: rule.allowedEntityClasses,
    }));

    return [...regexRules, ...nerRules];
  };

  const getAnonymizationOptions = (request: KibanaRequest) => {
    const namespace = core.savedObjects.getScopedClient(request).getCurrentNamespace() ?? 'default';
    const policyService = anonymization?.getPolicyService();
    const replacementsEncryptionKeyPromise = resolveReplacementsEncryptionKey({
      namespace,
      anonymizationEnabled,
      policyService,
    });
    // One read of the setting feeds both the rules and the failure mode.
    const legacySettingsPromise = anonymizationEnabled
      ? undefined
      : readLegacyAnonymizationSettings(request);
    return {
      namespace,
      anonymizationRulesPromise: createAnonymizationRulesPromise(request, legacySettingsPromise),
      regexWorker: worker,
      esClient: core.elasticsearch.asScoped(request).asCurrentUser,
      anonymization: {
        saltPromise: anonymizationEnabled ? policyService?.getSalt(namespace) : undefined,
        onFailurePromise: resolveOnFailureMode({ anonymizationEnabled, legacySettingsPromise }),
        replacements: {
          esClient: core.elasticsearch.asInternalUser,
          encryptionKeyPromise: replacementsEncryptionKeyPromise,
          usePersistentReplacements: anonymizationEnabled,
          requireEncryptionKey: anonymizationEnabled,
        },
      },
    };
  };

  const createDefaultConnectorOnlyCheck = (request: KibanaRequest) => {
    return async () => {
      const scopedSavedObjectsClient = core.savedObjects.getScopedClient(request);
      const uiSettingsClient = core.uiSettings.asScopedToClient(scopedSavedObjectsClient);
      return await uiSettingsClient.get<boolean>(
        GEN_AI_SETTINGS_DEFAULT_AI_CONNECTOR_DEFAULT_ONLY,
        {
          request,
        }
      );
    };
  };

  const createDefaultConnectorIdGetter = (request: KibanaRequest) => {
    return async () => {
      const scopedSavedObjectsClient = core.savedObjects.getScopedClient(request);
      const uiSettingsClient = core.uiSettings.asScopedToClient(scopedSavedObjectsClient);
      const defaultConnector = await loadDefaultConnector({
        actions,
        request,
        esClient: core.elasticsearch.asInternalUser,
        uiSettingsClient,
        logger,
      });
      return defaultConnector?.connectorId;
    };
  };

  // uses the internal ES client, like the default connector lookup, so that aliases resolve
  // the same way regardless of whether the user can list inference endpoints
  const createConnectorIdResolver = (request: KibanaRequest) => {
    return async (connectorId: string) => {
      const connector = await getConnectorById({
        connectorId,
        actions,
        request,
        esClient: core.elasticsearch.asInternalUser,
        logger,
      });
      return connector.connectorId;
    };
  };

  const createTokenUsageTrackingEnabledCheck = (request: KibanaRequest) => {
    return async () => {
      try {
        const scopedSavedObjectsClient = core.savedObjects.getScopedClient(request);
        const uiSettingsClient = core.uiSettings.asScopedToClient(scopedSavedObjectsClient);
        return await uiSettingsClient.get<boolean>(GEN_AI_SETTINGS_TOKEN_USAGE_TRACKING);
      } catch (e) {
        return false;
      }
    };
  };

  const createStreamingResolver = (request: KibanaRequest) =>
    createInferenceStreamingResolver({
      core: {
        elasticsearch: { client: core.elasticsearch },
        savedObjects: core.savedObjects,
        uiSettings: core.uiSettings,
      } as Pick<CoreStart, 'elasticsearch' | 'savedObjects' | 'uiSettings'>,
      logger,
      request,
    });

  const contract: InferenceServices['contract'] = {
    getClient: <T extends InferenceClientCreateOptions>(options: T) => {
      return createInferenceClient({
        ...options,
        ...getAnonymizationOptions(options.request),
        actions,
        logger: logger.get('client'),
        esClient: core.elasticsearch.asScoped(options.request).asCurrentUser,
        endpointIdCache: idCache,
        tokenUsageLogger,
        isTokenUsageTrackingEnabled: createTokenUsageTrackingEnabledCheck(options.request),
        isDefaultConnectorOnly: createDefaultConnectorOnlyCheck(options.request),
        getDefaultConnectorId: createDefaultConnectorIdGetter(options.request),
        resolveConnectorId: createConnectorIdResolver(options.request),
        shouldStreamInferenceEndpoint: createStreamingResolver(options.request),
      }) as T extends InferenceBoundClientCreateOptions ? BoundInferenceClient : InferenceClient;
    },

    getChatModel: async (options) => {
      return createChatModel({
        request: options.request,
        connectorId: options.connectorId,
        chatModelOptions: options.chatModelOptions,
        callbacks: options.callbacks,
        ...getAnonymizationOptions(options.request),
        actions,
        regexWorker: worker,
        esClient: core.elasticsearch.asScoped(options.request).asCurrentUser,
        endpointIdCache: idCache,
        logger,
        tokenUsageLogger,
        isTokenUsageTrackingEnabled: createTokenUsageTrackingEnabledCheck(options.request),
        isDefaultConnectorOnly: createDefaultConnectorOnlyCheck(options.request),
        getDefaultConnectorId: createDefaultConnectorIdGetter(options.request),
        resolveConnectorId: createConnectorIdResolver(options.request),
        shouldStreamInferenceEndpoint: createStreamingResolver(options.request),
      });
    },

    getConnectorList: async (request: KibanaRequest) => {
      const esClient = core.elasticsearch.asInternalUser;
      return getConnectorList({ actions, request, esClient, logger });
    },
    getDefaultConnector: async (request: KibanaRequest) => {
      const esClient = core.elasticsearch.asInternalUser;
      const scopedSavedObjectsClient = core.savedObjects.getScopedClient(request);
      const uiSettingsClient = core.uiSettings.asScopedToClient(scopedSavedObjectsClient);
      return loadDefaultConnector({ actions, request, esClient, uiSettingsClient, logger });
    },
    getConnectorById: runServices.getConnectorById,
    getClientWithoutRequest: runServices.getClientWithoutRequest,
    getConnectorByIdWithoutClientRequest: runServices.getConnectorByIdWithoutClientRequest,
    getInferenceEndpoints: async (taskType?: InferenceTaskType) => {
      const esClient = core.elasticsearch.asInternalUser;
      return getInferenceEndpoints({ esClient, taskType });
    },
    getInferenceEndpointById: async (inferenceId: string) => {
      const esClient = core.elasticsearch.asInternalUser;
      return getInferenceEndpointById({ inferenceId, esClient });
    },
  };

  return { contract, regexWorker: worker };
};
