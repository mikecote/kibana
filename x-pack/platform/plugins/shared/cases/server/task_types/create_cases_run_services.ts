/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { IUsageCounter } from '@kbn/usage-collection-plugin/server/usage_counters/usage_counter';
import type { Observable } from 'rxjs';
import type {
  AnalyticsServiceStart,
  IClusterClient,
  KibanaRequest,
  Logger,
  SavedObjectsServiceStart,
  SecurityServiceStart,
} from '@kbn/core/server';
import { createFilesRunServices } from '@kbn/files-plugin/server';
import type { ActionsClient } from '@kbn/actions-plugin/server';
import type { UserProfileServiceStart } from '@kbn/core-user-profile-server';
import type { ILicense } from '@kbn/licensing-types';
import type { AuditServiceSetup } from '@kbn/security-plugin-types-server';
import type { Space, SpacesPluginStart } from '@kbn/spaces-plugin/server';
import { SecurityLicenseService } from '@kbn/security-plugin/common/licensing/license_service';
import { authorizationModeFactory } from '@kbn/security-plugin/server/authorization/mode';
import type { RunTimeSecurity } from '@kbn/security-plugin/server/run_time_security';
import { UnifiedAttachmentTypeRegistry } from '../attachment_framework/unified_attachment_registry';
import { CasesClientFactory } from '../client/factory';
import type { CasesClient } from '../client';
import type { CasesClientSource, GetCasesClientOptions } from '../client/types';
import type { CasesAnalyticsV2DataViewRefresher } from '../cases_analytics_v2/service';
import { CasesAnalyticsV2Writer, V2_NOOP_WRITER } from '../cases_analytics_v2/writer';
import {
  CasesActivityV2Writer,
  V2_NOOP_ACTIVITY_WRITER,
} from '../cases_analytics_v2/writer/activity';
import {
  CasesAttachmentsV2Writer,
  V2_NOOP_ATTACHMENTS_WRITER,
} from '../cases_analytics_v2/writer/attachments';
import type { CasesEventBus } from '../events/event_bus';
import { registerInternalAttachments } from '../internal_attachments';
import type { CasesAlertsClient } from '../services/alerts';
import { createCaseFileKinds } from '../files';
import type { CasesWorkflowsProcessSettings } from './cases_task_process_settings';
import { taskProcessLensEmbeddableFactory } from './cases_saved_object_types';

const NOOP_DATA_VIEW_REFRESHER: CasesAnalyticsV2DataViewRefresher = () => {};

const onlyInKibana = (what: string) => (): never => {
  throw new Error(`${what} is only available in Kibana, not in a task process`);
};

/** What a task process has of the services the cases client is built from. */
export interface CasesRunServicesDeps {
  logger: Logger;
  /** What Kibana sent (`settings.cases.workflows`). */
  settings: CasesWorkflowsProcessSettings;
  elasticsearch: Pick<IClusterClient, 'asInternalUser' | 'asScoped'>;
  savedObjects: Pick<
    SavedObjectsServiceStart,
    'createInternalRepository' | 'getScopedClient' | 'createSerializer'
  >;
  /** The security task plugin: privilege checks and the audit log. */
  security: { authz: RunTimeSecurity['authz']; audit: AuditServiceSetup };
  /** Core's security service (the user of a request). */
  securityService: Pick<SecurityServiceStart, 'authc'>;
  userProfile: UserProfileServiceStart;
  spaces?: Pick<SpacesPluginStart['spacesService'], 'getSpaceId' | 'getActiveSpace'>;
  licensing: {
    license$: Observable<ILicense>;
    featureUsage?: { notifyUsage: (featureName: string, usedAt?: number | Date) => void };
  };
  getActionsClientWithRequest: (request: KibanaRequest) => Promise<unknown>;
  /**
   * The usage counter of the `cases` domain, as `usageCollection.createUsageCounter` gives Kibana:
   * in a process the process counts and stores it itself when the run ends.
   */
  usageCounter: IUsageCounter;
  filesUsageCounter: IUsageCounter;
  analytics: Pick<AnalyticsServiceStart, 'reportEvent'>;
  publicBaseUrl?: string;
  isFipsMode: boolean;
  getAttachmentParityError: () => string | undefined;
  getRacClientWithRequest: (request: KibanaRequest) => Promise<CasesAlertsClient>;
  /** The bus the client emits its events on: the caller bridges it to the workflow triggers. */
  casesEventBus: CasesEventBus;
  /** What the client records as its source: `workflow` for the steps, `agent_builder` for the tools. */
  clientSource?: CasesClientSource;
  /** The attachment types to use, with the internal ones registered by the caller (a new registry with them when not given). */
  unifiedAttachmentTypeRegistry?: UnifiedAttachmentTypeRegistry;
}

export interface CasesRunServices {
  /** The native attachment registry restored from the current dispatch. */
  unifiedAttachmentTypeRegistry: UnifiedAttachmentTypeRegistry;
  /** The space of a request, as the spaces plugin gives it: `undefined` when spaces are disabled. */
  getActiveSpace?: (request: KibanaRequest) => Promise<Space>;
  getCasesClient: (request: KibanaRequest, options?: GetCasesClientOptions) => Promise<CasesClient>;
}

/** Builds native Cases clients with scoped storage, alerts, files and restored attachment types. */
export const createCasesRunServices = ({
  logger,
  settings,
  elasticsearch,
  savedObjects,
  security,
  securityService,
  userProfile,
  spaces,
  licensing,
  getActionsClientWithRequest,
  usageCounter,
  filesUsageCounter,
  analytics,
  publicBaseUrl,
  isFipsMode,
  getAttachmentParityError,
  getRacClientWithRequest,
  casesEventBus,
  clientSource = 'workflow',
  unifiedAttachmentTypeRegistry: providedRegistry,
}: CasesRunServicesDeps): CasesRunServices => {
  const unifiedAttachmentTypeRegistry = providedRegistry ?? new UnifiedAttachmentTypeRegistry();
  if (!providedRegistry) registerInternalAttachments(unifiedAttachmentTypeRegistry);

  // The authorization mode of the security plugin, from the same license logic.
  const securityLicense = new SecurityLicenseService().setup({
    license$: licensing.license$,
  }).license;
  const { spacesEnabled, config } = settings;
  if (spacesEnabled && !spaces) throw new Error('Cases operations require native Spaces services');

  // The analytics v2 writers write to indices that Kibana created.
  const analyticsV2 = config.analyticsV2.enabled
    ? {
        writer: new CasesAnalyticsV2Writer({
          esClient: elasticsearch.asInternalUser,
          logger,
        }),
        activityWriter: new CasesActivityV2Writer({
          esClient: elasticsearch.asInternalUser,
          logger,
        }),
        attachmentsWriter: new CasesAttachmentsV2Writer({
          esClient: elasticsearch.asInternalUser,
          logger,
        }),
      }
    : {
        writer: V2_NOOP_WRITER,
        activityWriter: V2_NOOP_ACTIVITY_WRITER,
        attachmentsWriter: V2_NOOP_ATTACHMENTS_WRITER,
      };

  const factory = new CasesClientFactory(logger);
  factory.initialize({
    securityPluginSetup: { audit: security.audit },
    securityPluginStart: {
      authz: { ...security.authz, mode: authorizationModeFactory(securityLicense) },
      userProfiles: userProfile,
    },
    securityServiceStart: securityService,
    spacesPluginStart: spaces ? { spacesService: spaces } : undefined,
    featuresPluginStart: {
      getKibanaFeatures: () => settings.featureCaseOwners,
    },
    actionsPluginStart: {
      getActionsClientWithRequest: (request) =>
        getActionsClientWithRequest(request) as Promise<ActionsClient>,
    },
    licensingPluginStart: {
      license$: licensing.license$,
      featureUsage: {
        notifyUsage: (featureName, usedAt) => {
          if (!licensing.featureUsage) {
            throw new Error('The task process did not give the license feature usage');
          }
          licensing.featureUsage.notifyUsage(featureName, usedAt);
        },
      },
    },
    lensEmbeddableFactory: taskProcessLensEmbeddableFactory,
    unifiedAttachmentTypeRegistry,
    publicBaseUrl,
    notifications: {
      // A run that would send an email is declined when Kibana can send emails, so this is false only
      // when Kibana cannot either.
      isEmailServiceAvailable: () => settings.isEmailServiceAvailable,
      getEmailService: onlyInKibana('The email service'),
    },
    ruleRegistry: { getRacClientWithRequest },
    filesPluginStart: createFilesRunServices({
      savedObjects,
      esClient: elasticsearch.asInternalUser,
      security: { audit: security.audit },
      logger: logger.get('files'),
      analytics,
      usageCounter: filesUsageCounter,
      fileKinds: Object.values(createCaseFileKinds(settings.config.files, isFipsMode)),
    }),
    usageCounter,
    config,
    casesEventBus,
    // A run that sets a close reason is declined when a plugin registered a validator.
    closeReasonValidator: undefined,
    analyticsV2Writer: analyticsV2.writer,
    analyticsV2ActivityWriter: analyticsV2.activityWriter,
    analyticsV2AttachmentsWriter: analyticsV2.attachmentsWriter,
    // The steps never change templates or field definitions.
    analyticsV2DataViewRefresher: NOOP_DATA_VIEW_REFRESHER,
  });

  return {
    unifiedAttachmentTypeRegistry,
    getActiveSpace: spaces?.getActiveSpace.bind(spaces),
    getCasesClient: async (request, options) => {
      const parityError = getAttachmentParityError();
      if (parityError) throw new Error(parityError);
      return factory.create({
        request,
        scopedClusterClient: elasticsearch.asScoped(request).asCurrentUser,
        savedObjectsService: savedObjects,
        clientSource,
        actionSource: options?.actionSource,
      });
    },
  };
};
