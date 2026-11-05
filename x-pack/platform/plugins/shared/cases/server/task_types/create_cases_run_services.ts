/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Observable } from 'rxjs';
import type {
  IClusterClient,
  KibanaRequest,
  Logger,
  SavedObjectsServiceStart,
  SecurityServiceStart,
} from '@kbn/core/server';
import type { FilesStart } from '@kbn/files-plugin/server';
import { DEFAULT_SPACE_ID } from '@kbn/core-spaces-common';
import { SavedObjectsSerializer } from '@kbn/core-saved-objects-base-server-internal';
import type { ActionsClient } from '@kbn/actions-plugin/server';
import type { UserProfileServiceStart } from '@kbn/core-user-profile-server';
import type { ILicense } from '@kbn/licensing-types';
import type { AuditServiceSetup } from '@kbn/security-plugin-types-server';
import type { Space } from '@kbn/spaces-plugin/server';
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
import type { CasesWorkflowsProcessSettings } from './cases_task_process_settings';
import { taskProcessLensEmbeddableFactory } from './cases_saved_object_types';
import { CASES_USAGE_COUNTER_TELEMETRY_KIND } from './cases_task_process_settings';

const SPACE_SAVED_OBJECT_TYPE = 'space';

const NOOP_DATA_VIEW_REFRESHER: CasesAnalyticsV2DataViewRefresher = () => {};

const onlyInKibana = (what: string) => (): never => {
  throw new Error(`${what} is only available in Kibana, not in a task process`);
};

/** An object whose every method throws: for a service that cannot exist in a task process. */
const onlyInKibanaService = <T extends object>(what: string): T =>
  new Proxy(
    {},
    {
      // Not a thenable, so that awaiting the service does not call it.
      get: (_target, property) =>
        property === 'then' || typeof property === 'symbol'
          ? undefined
          : onlyInKibana(`${what} (${property})`),
    }
  ) as T;

/** What a task process has of the services the cases client is built from. */
export interface CasesRunServicesDeps {
  logger: Logger;
  /** What Kibana sent (`settings.cases.workflows`). */
  settings: CasesWorkflowsProcessSettings;
  elasticsearch: Pick<IClusterClient, 'asInternalUser' | 'asScoped'>;
  savedObjects: Pick<
    SavedObjectsServiceStart,
    'createInternalRepository' | 'getScopedClient' | 'getTypeRegistry'
  >;
  /** The security task plugin: privilege checks and the audit log. */
  security: { authz: RunTimeSecurity['authz']; audit: AuditServiceSetup };
  /** Core's security service (the user of a request). */
  securityService: Pick<SecurityServiceStart, 'authc'>;
  userProfile: UserProfileServiceStart;
  licensing: {
    license$: Observable<ILicense>;
    featureUsage?: { notifyUsage: (featureName: string, usedAt?: number | Date) => void };
  };
  getActionsClientWithRequest: (request: KibanaRequest) => Promise<unknown>;
  /** What the run reports to Kibana: usage counters go back on a channel Kibana's cases sink reads. */
  telemetry: { report: (kind: string, payload: unknown) => void };
  publicBaseUrl?: string;
  /** The bus the client emits its events on: the caller bridges it to the workflow triggers. */
  casesEventBus: CasesEventBus;
}

export interface CasesRunServices {
  getCasesClient: (request: KibanaRequest, options?: GetCasesClientOptions) => Promise<CasesClient>;
}

/**
 * The cases client of a task process: the same `CasesClientFactory` Kibana uses, built from what a
 * process has instead of the plugins' start contracts. What a process cannot have throws when used:
 *
 * - the alerts client of the rule registry and the files service (their steps are Kibana-only),
 * - the email service (a run that would notify assignees is declined when Kibana can send emails).
 *
 * Its attachment type registry only has the types cases registers itself: a step that adds
 * attachments of the types solutions register is Kibana-only.
 */
export const createCasesRunServices = ({
  logger,
  settings,
  elasticsearch,
  savedObjects,
  security,
  securityService,
  userProfile,
  licensing,
  getActionsClientWithRequest,
  telemetry,
  publicBaseUrl,
  casesEventBus,
}: CasesRunServicesDeps): CasesRunServices => {
  const unifiedAttachmentTypeRegistry = new UnifiedAttachmentTypeRegistry();
  registerInternalAttachments(unifiedAttachmentTypeRegistry);

  // The authorization mode of the security plugin, from the same license logic.
  const securityLicense = new SecurityLicenseService().setup({
    license$: licensing.license$,
  }).license;
  const { spacesEnabled, config } = settings;
  const spaceRepository = savedObjects.createInternalRepository([SPACE_SAVED_OBJECT_TYPE]);

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
    spacesPluginStart: spacesEnabled
      ? {
          spacesService: {
            getSpaceId: (request) => request.spaceId ?? DEFAULT_SPACE_ID,
            getActiveSpace: async (request) => {
              const { id, attributes } = await spaceRepository.get<Omit<Space, 'id'>>(
                SPACE_SAVED_OBJECT_TYPE,
                request.spaceId ?? DEFAULT_SPACE_ID
              );
              return { id, ...attributes } as Space;
            },
          },
        }
      : undefined,
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
    ruleRegistry: {
      getRacClientWithRequest: async () =>
        onlyInKibanaService<CasesAlertsClient>('The alerts client'),
    },
    filesPluginStart: {
      fileServiceFactory: {
        asScoped: () =>
          onlyInKibanaService<ReturnType<FilesStart['fileServiceFactory']['asScoped']>>(
            'The file service'
          ),
      },
    },
    usageCounter: {
      domainId: 'cases',
      incrementCounter: (params) => telemetry.report(CASES_USAGE_COUNTER_TELEMETRY_KIND, params),
    },
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

  const savedObjectsService = {
    getScopedClient: savedObjects.getScopedClient,
    createSerializer: () =>
      // Core builds it over the same registry; the process has the part of it the serializer reads.
      new SavedObjectsSerializer(savedObjects.getTypeRegistry() as never),
  };

  return {
    getCasesClient: (request, options) =>
      factory.create({
        request,
        scopedClusterClient: elasticsearch.asScoped(request).asCurrentUser,
        savedObjectsService,
        clientSource: 'workflow' satisfies CasesClientSource,
        actionSource: options?.actionSource,
      }),
  };
};
