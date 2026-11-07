/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Observable, Subscription } from 'rxjs';
import { BehaviorSubject } from 'rxjs';
import { kibanaPackageJson } from '@kbn/repo-info';

import type { HttpServiceSetup, KibanaRequest } from '@kbn/core-http-server';
import type { PluginStart as DataPluginStart } from '@kbn/data-plugin/server';
import type {
  EncryptedSavedObjectsClient,
  EncryptedSavedObjectsPluginSetup,
  EncryptedSavedObjectsPluginStart,
} from '@kbn/encrypted-saved-objects-plugin/server';
import type { SecurityPluginStart, SecurityPluginSetup } from '@kbn/security-plugin/server';
import type { CloudSetup } from '@kbn/cloud-plugin/server';
import { DEFAULT_SPACE_ID } from '@kbn/core-spaces-common';
import type { SavedObjectTaggingStart } from '@kbn/saved-objects-tagging-plugin/server';
import type { SavedObjectsServiceStart } from '@kbn/core-saved-objects-server';
import { SPACES_EXTENSION_ID } from '@kbn/core-saved-objects-server';
import type { TaskManagerStartContract } from '@kbn/task-manager-plugin/server';
import type { ElasticsearchClient, IClusterClient } from '@kbn/core-elasticsearch-server';
import type { SecurityServiceStart } from '@kbn/core-security-server';
import type { Logger } from '@kbn/logging';
import type { FeatureFlagsStart } from '@kbn/core-feature-flags-server';
import type { LockManagerService } from '@kbn/lock-manager';
import type { AlertingServerStart } from '@kbn/alerting-plugin/server';
import type { ReportingStart } from '@kbn/reporting-plugin/server';
import { ALL_SPACES_ID } from '@kbn/spaces-plugin/common/constants';

import type { FleetConfigType } from '../../common/types';
import {
  allowedExperimentalValues,
  type ExperimentalFeatures,
} from '../../common/experimental_features';
import type {
  ExternalCallback,
  ExternalCallbacksStorage,
  PostPackagePolicyDeleteCallback,
  PostPackagePolicyCreateCallback,
  PostPackagePolicyPostDeleteCallback,
  PostPackagePolicyPostCreateCallback,
  PutPackagePolicyUpdateCallback,
  PostAgentPolicyCreateCallback,
  PostAgentPolicyUpdateCallback,
} from '../types';
import { KibanaSavedObjectType } from '../types';
import type { FleetAppContext } from '../plugin';
import type { FleetPackageMetadataTaskProcessSettings } from '../package_metadata_task_process_settings';
import type { TelemetryEventsSender } from '../telemetry/sender';
import { UNINSTALL_TOKENS_SAVED_OBJECT_TYPE } from '../constants';
import type { MessageSigningServiceInterface } from '..';
import type { FleetUsage } from '../collectors/register';

import type { BulkActionsResolver } from './agents/bulk_actions_resolver';
import { type UninstallTokenServiceInterface } from './security/uninstall_token_service';

/** The hidden saved object types Fleet's internal saved objects clients ask for. */
export const DEFAULT_INCLUDED_HIDDEN_TYPES = [
  UNINSTALL_TOKENS_SAVED_OBJECT_TYPE,
  KibanaSavedObjectType.alertingRuleTemplate,
  KibanaSavedObjectType.sloTemplate,
];

export interface FleetExecutionAppContext {
  elasticsearch: Pick<IClusterClient, 'asInternalUser'>;
  savedObjects: SavedObjectsServiceStart;
  encryptedSavedObjectsStart?: Pick<EncryptedSavedObjectsPluginStart, 'getClient'>;
  encryptedSavedObjectsSetup?: Pick<EncryptedSavedObjectsPluginSetup, 'canEncrypt'>;
  securitySetup: Pick<SecurityPluginSetup, 'audit' | 'license'>;
  config$?: Observable<FleetConfigType>;
  configInitialValue: FleetConfigType;
  experimentalFeatures: ExperimentalFeatures;
  logger?: Logger;
  kibanaVersion: string;
  kibanaBranch: string;
  kibanaInstanceId: string;
  isProductionMode: boolean;
  isFipsEnabled: boolean;
  includedHiddenTypes?: string[];
  registry:
    | { kind: 'native' }
    | { kind: 'snapshot'; settings: FleetPackageMetadataTaskProcessSettings };
}

class AppContextService {
  private encryptedSavedObjects: EncryptedSavedObjectsClient | undefined;
  private encryptedSavedObjectsSetup: FleetExecutionAppContext['encryptedSavedObjectsSetup'];
  private encryptedSavedObjectsStart: FleetExecutionAppContext['encryptedSavedObjectsStart'];
  private data: DataPluginStart | undefined;
  private esClient: ElasticsearchClient | undefined;
  private experimentalFeatures: ExperimentalFeatures = allowedExperimentalValues;
  private securityCoreStart: SecurityServiceStart | undefined;
  private securitySetup: FleetExecutionAppContext['securitySetup'] | undefined;
  private securityStart: SecurityPluginStart | undefined;
  private config$?: Observable<FleetConfigType>;
  private configSubscription?: Subscription;
  private registry?: FleetExecutionAppContext['registry'];
  private configSubject$?: BehaviorSubject<FleetConfigType>;
  private savedObjects: SavedObjectsServiceStart | undefined;
  private isProductionMode: FleetAppContext['isProductionMode'] = false;
  private kibanaVersion: FleetAppContext['kibanaVersion'] = kibanaPackageJson.version;
  private kibanaBranch: FleetAppContext['kibanaBranch'] = kibanaPackageJson.branch;
  private kibanaInstanceId: FleetAppContext['kibanaInstanceId'] = '';
  private cloud?: CloudSetup;
  private logger: Logger | undefined;
  private httpSetup?: HttpServiceSetup;
  private externalCallbacks: ExternalCallbacksStorage = new Map();
  private telemetryEventsSender: TelemetryEventsSender | undefined;
  private savedObjectsTagging: SavedObjectTaggingStart | undefined;
  private bulkActionsResolver: BulkActionsResolver | undefined;
  private messageSigningService: MessageSigningServiceInterface | undefined;
  private uninstallTokenService: UninstallTokenServiceInterface | undefined;
  private taskManagerStart: TaskManagerStartContract | undefined;
  private fetchUsage?: (signal: AbortSignal) => Promise<FleetUsage | undefined>;
  private lockManagerService: LockManagerService | undefined;
  private alertingStart: AlertingServerStart | undefined;
  private includedHiddenTypes: string[] = DEFAULT_INCLUDED_HIDDEN_TYPES;
  private reportingStart: ReportingStart | undefined;
  private featureFlags: FeatureFlagsStart | undefined;
  private isFipsEnabled: boolean = false;

  public start(appContext: FleetAppContext) {
    this.startExecution({
      ...appContext,
      elasticsearch: appContext.elasticsearch.client,
      registry: { kind: 'native' },
    });
    this.data = appContext.data;
    this.securityCoreStart = appContext.securityCoreStart;
    this.securityStart = appContext.securityStart;
    this.cloud = appContext.cloud;
    this.httpSetup = appContext.httpSetup;
    this.telemetryEventsSender = appContext.telemetryEventsSender;
    this.savedObjectsTagging = appContext.savedObjectsTagging;
    this.bulkActionsResolver = appContext.bulkActionsResolver;
    this.messageSigningService = appContext.messageSigningService;
    this.uninstallTokenService = appContext.uninstallTokenService;
    this.taskManagerStart = appContext.taskManagerStart;
    this.fetchUsage = appContext.fetchUsage;
    this.lockManagerService = appContext.lockManagerService;
    this.alertingStart = appContext.alertingStart;
    this.reportingStart = appContext.reportingStart;
    this.featureFlags = appContext.featureFlags;
  }

  /** Initializes the actual execution services shared by native Fleet and task workers. */
  public startExecution(appContext: FleetExecutionAppContext): void {
    this.registry = appContext.registry;
    this.esClient = appContext.elasticsearch.asInternalUser;
    this.encryptedSavedObjectsStart = appContext.encryptedSavedObjectsStart;
    this.encryptedSavedObjects = appContext.encryptedSavedObjectsStart?.getClient();
    this.encryptedSavedObjectsSetup = appContext.encryptedSavedObjectsSetup;
    this.securitySetup = appContext.securitySetup;
    this.savedObjects = appContext.savedObjects;
    this.experimentalFeatures = appContext.experimentalFeatures;
    this.isProductionMode = appContext.isProductionMode;
    this.logger = appContext.logger;
    this.kibanaVersion = appContext.kibanaVersion;
    this.kibanaBranch = appContext.kibanaBranch;
    this.kibanaInstanceId = appContext.kibanaInstanceId;
    this.isFipsEnabled = appContext.isFipsEnabled;
    this.includedHiddenTypes = appContext.includedHiddenTypes ?? DEFAULT_INCLUDED_HIDDEN_TYPES;
    this.configSubscription?.unsubscribe();
    this.config$ = appContext.config$;
    this.configSubject$ = new BehaviorSubject(appContext.configInitialValue);
    this.configSubscription = this.config$?.subscribe(this.configSubject$);
  }

  public stop() {
    this.configSubscription?.unsubscribe();
    this.externalCallbacks.clear();
  }

  public getData() {
    if (!this.data) {
      throw new Error('Data start service not set.');
    }
    return this.data;
  }

  public getEncryptedSavedObjects() {
    if (!this.encryptedSavedObjects) {
      throw new Error('Encrypted saved object start service not set.');
    }
    return this.encryptedSavedObjects;
  }

  public getSecurityCore() {
    return this.securityCoreStart!;
  }

  public getSecurity() {
    return this.securityStart!;
  }

  public getSecuritySetup() {
    return this.securitySetup!;
  }

  public getSecurityLicense() {
    const license = this.securitySetup?.license;
    if (!license) throw new Error('Security license not set.');
    return license;
  }

  public getIsFipsEnabled() {
    return this.isFipsEnabled;
  }

  public getCloud() {
    return this.cloud;
  }

  public getLogger() {
    if (!this.logger) {
      throw new Error('Logger not set.');
    }
    return this.logger;
  }

  public getConfig() {
    return this.configSubject$?.value;
  }

  /** Returns captured registry material only for an execution initialized from a dispatch snapshot. */
  public getPackageMetadata(): FleetPackageMetadataTaskProcessSettings | undefined {
    if (!this.registry) throw new Error('Fleet registry execution has not initialized');
    return this.registry.kind === 'snapshot' ? this.registry.settings : undefined;
  }

  public getConfig$() {
    return this.config$;
  }

  public getExperimentalFeatures() {
    return this.experimentalFeatures;
  }

  public getSavedObjects() {
    if (!this.savedObjects) {
      throw new Error('Saved objects start service not set.');
    }
    return this.savedObjects;
  }

  public getSavedObjectsTagging() {
    if (!this.savedObjectsTagging) {
      throw new Error('Saved object tagging start service not set.');
    }
    return this.savedObjectsTagging;
  }
  public getInternalUserSOClientForSpaceId(spaceId?: string) {
    // soClient as kibana internal users, be careful on how you use it, security is not enabled
    if (spaceId && spaceId !== DEFAULT_SPACE_ID && spaceId !== ALL_SPACES_ID) {
      return appContextService
        .getSavedObjects()
        .getUnsafeInternalClient({
          includedHiddenTypes: this.includedHiddenTypes,
        })
        .asScopedToNamespace(spaceId);
    }
    return this.getInternalUserSOClientWithoutSpaceExtension();
  }

  public getInternalUserSOClient(request?: KibanaRequest) {
    if (request) {
      return appContextService.getSavedObjects().getScopedClient(request, {
        includedHiddenTypes: this.includedHiddenTypes,
      });
    }

    return appContextService.getSavedObjects().getUnsafeInternalClient({
      includedHiddenTypes: this.includedHiddenTypes,
    });
  }

  public getInternalUserSOClientWithoutSpaceExtension() {
    // soClient as kibana internal users, be careful on how you use it, security is not enabled
    return appContextService.getSavedObjects().getUnsafeInternalClient({
      excludedExtensions: [SPACES_EXTENSION_ID],
      includedHiddenTypes: this.includedHiddenTypes,
    });
  }

  public getInternalUserESClient() {
    if (!this.esClient) {
      throw new Error('Elasticsearch start service not set.');
    }
    // soClient as kibana internal users, be careful on how you use it, security is not enabled
    return this.esClient;
  }

  public getIsProductionMode() {
    return this.isProductionMode;
  }

  public getHttpSetup() {
    if (!this.httpSetup) {
      throw new Error('HttpServiceSetup not set.');
    }
    return this.httpSetup;
  }

  public getEncryptedSavedObjectsSetup() {
    return this.encryptedSavedObjectsSetup;
  }

  public getEncryptedSavedObjectsStart() {
    return this.encryptedSavedObjectsStart;
  }

  public getKibanaVersion() {
    return this.kibanaVersion;
  }

  public getKibanaBranch() {
    return this.kibanaBranch;
  }

  public getKibanaInstanceId() {
    return this.kibanaInstanceId;
  }

  public getTaskManagerStart() {
    return this.taskManagerStart;
  }

  public addExternalCallback(type: ExternalCallback[0], callback: ExternalCallback[1]) {
    if (!this.externalCallbacks.has(type)) {
      this.externalCallbacks.set(type, new Set());
    }
    this.externalCallbacks.get(type)!.add(callback);
  }

  public getExternalCallbacks<T extends ExternalCallback[0]>(
    type: T
  ):
    | Set<
        T extends 'agentPolicyCreate'
          ? PostAgentPolicyCreateCallback
          : T extends 'agentPolicyUpdate'
          ? PostAgentPolicyUpdateCallback
          : T extends 'packagePolicyCreate'
          ? PostPackagePolicyCreateCallback
          : T extends 'packagePolicyDelete'
          ? PostPackagePolicyDeleteCallback
          : T extends 'packagePolicyPostDelete'
          ? PostPackagePolicyPostDeleteCallback
          : T extends 'packagePolicyPostCreate'
          ? PostPackagePolicyPostCreateCallback
          : PutPackagePolicyUpdateCallback
      >
    | undefined {
    if (this.externalCallbacks) {
      return this.externalCallbacks.get(type) as Set<
        T extends 'agentPolicyCreate'
          ? PostAgentPolicyCreateCallback
          : T extends 'agentPolicyUpdate'
          ? PostAgentPolicyUpdateCallback
          : T extends 'packagePolicyCreate'
          ? PostPackagePolicyCreateCallback
          : T extends 'packagePolicyDelete'
          ? PostPackagePolicyDeleteCallback
          : T extends 'packagePolicyPostDelete'
          ? PostPackagePolicyPostDeleteCallback
          : T extends 'packagePolicyPostCreate'
          ? PostPackagePolicyPostCreateCallback
          : PutPackagePolicyUpdateCallback
      >;
    }
  }

  public getTelemetryEventsSender() {
    return this.telemetryEventsSender;
  }

  public getBulkActionsResolver() {
    return this.bulkActionsResolver;
  }

  public getMessageSigningService() {
    return this.messageSigningService;
  }

  public getUninstallTokenService() {
    return this.uninstallTokenService;
  }

  public getFetchUsage() {
    return this.fetchUsage;
  }

  public getLockManagerService() {
    return this.lockManagerService;
  }

  public getAlertingStart() {
    return this.alertingStart;
  }

  public getReportingStart() {
    return this.reportingStart;
  }

  public getFeatureFlags() {
    return this.featureFlags;
  }
}

export const appContextService = new AppContextService();
