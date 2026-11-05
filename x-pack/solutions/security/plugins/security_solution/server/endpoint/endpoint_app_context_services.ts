/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type {
  AnalyticsServiceSetup,
  ElasticsearchClient,
  IClusterClient,
  KibanaRequest,
  LoggerFactory,
  SavedObjectsClientContract,
  SavedObjectsServiceStart,
  SecurityServiceStart,
} from '@kbn/core/server';
import type { IScopedSearchClient, PluginStart as DataPluginStart } from '@kbn/data-plugin/server';
import type {
  ExceptionListClient,
  ListPluginSetup,
  ListsServerExtensionRegistrar,
} from '@kbn/lists-plugin/server';
import type { CasesClient, CasesServerStart } from '@kbn/cases-plugin/server';
import type {
  FleetFromHostFileClientInterface,
  FleetStartContract,
  MessageSigningServiceInterface,
} from '@kbn/fleet-plugin/server';
import type {
  AlertingAuthorization,
  AlertingServerStart,
  RulesClient as RulesClientApi,
} from '@kbn/alerting-plugin/server';
import type { PublicMethodsOf } from '@kbn/utility-types';
import type { RulesClient } from '@kbn/alerting-plugin/server/rules_client';
import type { CloudSetup } from '@kbn/cloud-plugin/server';
import type { FleetActionsClientInterface } from '@kbn/fleet-plugin/server/services/actions/types';
import type {
  IUnsecuredActionsClient,
  PluginStartContract as ActionsPluginStartContract,
} from '@kbn/actions-plugin/server';
import type { Space } from '@kbn/spaces-plugin/common';
import { DEFAULT_SPACE_ID } from '@kbn/core-spaces-common';
import type { SpacesServiceStart } from '@kbn/spaces-plugin/server';
import type { AgentBuilderPluginStart } from '@kbn/agent-builder-server';
import {
  ScriptsLibraryClient,
  type ScriptsLibraryClientInterface,
} from './services/scripts_library';
import { EndpointError } from '../../common/endpoint/errors';
import {
  installScriptsLibraryIndexTemplates,
  SCRIPTS_LIBRARY_SAVED_OBJECT_TYPE,
} from './lib/scripts_library';
import type { OptInStatusMetadata, ReferenceDataClientInterface } from './lib/reference_data';
import { REF_DATA_KEYS, ReferenceDataClient } from './lib/reference_data';
import type { TelemetryConfigProvider } from '../../common/telemetry_config/telemetry_config_provider';
import { SavedObjectsClientFactory } from './services/saved_objects';
import type { ResponseActionsClient } from './services';
import { getResponseActionsClient, NormalizedExternalConnectorClient } from './services';
import {
  getAgentPolicyCreateCallback,
  getAgentPolicyPostUpdateCallback,
  getAgentPolicyUpdateCallback,
  getPackagePolicyCreateCallback,
  getPackagePolicyDeleteCallback,
  getPackagePolicyPostCreateCallback,
  getPackagePolicyPostUpdateCallback,
  getPackagePolicyUpdateCallback,
} from '../fleet_integration/fleet_integration';
import type { ManifestManager } from './services/artifacts';
import type { ConfigType } from '../config';
import type { IRequestContextFactory } from '../request_context_factory';
import type { LicenseService } from '../../common/license';
import { EndpointMetadataService } from './services/metadata';
import {
  EndpointAppContentServicesKibanaOnlyError,
  EndpointAppContentServicesNotSetUpError,
  EndpointAppContentServicesNotStartedError,
} from './errors';
import type {
  EndpointFleetServicesFactoryInterface,
  EndpointInternalFleetServicesInterface,
  EndpointFleetStartServices,
} from './services/fleet/endpoint_fleet_services_factory';
import { EndpointFleetServicesFactory } from './services/fleet/endpoint_fleet_services_factory';
import { registerListsPluginEndpointExtensionPoints } from '../lists_integration';
import type { EndpointAuthz } from '../../common/endpoint/types/authz';
import { calculateEndpointAuthz } from '../../common/endpoint/service/authz';
import type { FeatureUsageService } from './services/feature_usage/service';
import type { ExperimentalFeatures } from '../../common/experimental_features';
import type { ProductFeaturesService } from '../lib/product_features_service/product_features_service';
import type { ResponseActionAgentType } from '../../common/endpoint/service/response_actions/constants';
import { ScopedEndpointArtifactListClient } from './services/scoped_endpoint_artifact_list_client';
import { SimpleMemCache } from './lib/simple_mem_cache';
import { hasConnectedRemoteClusters } from './utils/ccs_utils';
import { setYaraLogger } from './lib/libyara';

/** Time-to-live (seconds) for the cached connected-remote-clusters check backing `isCcsEnabled` */
const CCS_CACHE_TTL_SECONDS = 60;
/** Single cache key used by `isCcsEnabled` (the cache only ever holds this one entry) */
const CCS_CACHE_KEY = 'hasConnectedRemoteClusters';

/** What the response actions read of the config, which a task process receives as settings */
export type EndpointAppContextServiceRunConfig = Pick<
  ConfigType,
  'maxUploadResponseActionFileBytes' | 'maxEndpointScriptFileSize'
>;

export interface EndpointAppContextServiceSetupContract {
  /** Used by the Fleet callbacks, which only Kibana registers */
  securitySolutionRequestContextFactory?: IRequestContextFactory;
  cloud?: CloudSetup;
  loggerFactory: LoggerFactory;
  telemetry: Pick<AnalyticsServiceSetup, 'reportEvent'>;
}

/**
 * What the response actions need of the app context, which Kibana's `start()` and a task process
 * (`createEndpointResponseActionsRunServices`) both provide through `initialize()`.
 */
export interface EndpointAppContextServiceInitializeContract {
  fleetStartServices: EndpointFleetStartServices &
    Pick<FleetStartContract, 'messageSigningService' | 'createFleetActionsClient'> &
    Partial<Pick<FleetStartContract, 'createFilesClient' | 'authz' | 'registerExternalCallback'>>;
  security: Pick<SecurityServiceStart, 'authc'>;
  config: EndpointAppContextServiceRunConfig & Partial<ConfigType>;
  licenseService: LicenseService;
  featureUsageService: FeatureUsageService;
  experimentalFeatures: ExperimentalFeatures;
  /** An internal ES client */
  esClient: ElasticsearchClient;
  savedObjectsServiceStart: Pick<SavedObjectsServiceStart, 'getScopedClient'>;
  /** Only the response actions of 3rd party EDRs use it, and only Kibana has it */
  connectorActions?: ActionsPluginStartContract;
}

export interface EndpointAppContextServiceStartContract
  extends Omit<EndpointAppContextServiceInitializeContract, 'fleetStartServices'> {
  fleetStartServices: FleetStartContract;
  manifestManager: ManifestManager;
  alerting: AlertingServerStart;
  registerListsServerExtension?: ListsServerExtensionRegistrar;
  exceptionListsClient: ExceptionListClient | undefined;
  cases: CasesServerStart | undefined;
  /** Used to build the request-scoped, project-routed client that CPS reads fan out on */
  clusterClient: IClusterClient;
  /** Used to build the project-routed search client that CPS search strategies fan out on */
  dataStart: DataPluginStart;
  /**
   * Resolves whether THIS request can fan out: deployment capability AND the
   * `defendCrossProjectSearch` flag AND at least one visible linked project.
   */
  isCpsActive: (request: KibanaRequest) => Promise<boolean>;
  productFeaturesService: ProductFeaturesService;
  savedObjectsServiceStart: SavedObjectsServiceStart;
  telemetryConfigProvider: TelemetryConfigProvider;
  spacesService: SpacesServiceStart | undefined;
  agentBuilder?: AgentBuilderPluginStart;
  getExceptionListClient?: ListPluginSetup['getExceptionListClient'];
}

/** What the app context keeps: everything a task process has, and what only Kibana has when set */
type EndpointAppContextServiceDependencies = EndpointAppContextServiceInitializeContract &
  Partial<
    Omit<EndpointAppContextServiceStartContract, keyof EndpointAppContextServiceInitializeContract>
  >;

/**
 * The request-bound half of the CPS primitives, handed out by `EndpointAppContextService.asScoped()`.
 *
 * Services take this rather than a `KibanaRequest` so that they stay independent of the HTTP routing
 * layer. Holding one means the caller had a request identity, which is the precondition for a read to
 * fan out; a service that receives none reads origin-only, exactly as before CPS.
 */
export interface ScopedEndpointServices {
  /** `true` when reads made through this instance fan out across linked projects */
  isCpsRead: () => boolean;
  /** The client for reads against Defend-owned indices. Fleet-owned ones stay on the internal client */
  getEsClient: () => ElasticsearchClient;
  /** The search client the Defend search strategies dispatch through */
  getSearchClient: () => IScopedSearchClient;
  /** The active space, which is also what bounds the set of projects a fanned-out read reaches */
  getSpaceId: () => string;
  /** Resolves the active space, rejecting when it does not exist on this project */
  getSpace: () => Promise<Space>;
}

/**
 * Options for {@link EndpointAppContextService#getInternalResponseActionsClient}.
 *
 * The option set is a discriminated union on `isAutomated` so that the two usage modes are
 * each enforced by construction instead of by review discipline:
 *  - `isAutomated: true` (or omitted) — system/rule-triggered actions (detection-rule response
 *    actions, the pending-actions task runner). Username defaults to the internal `'elastic'`
 *    system user, exactly as before this option existed.
 *  - `isAutomated: false` — analyst/user-initiated actions (e.g. AI Agent skill tools gated
 *    behind HITL confirmation). A `request` is REQUIRED: the username is derived from the
 *    authenticated user so the audit trail never silently attributes a manual action to the
 *    system user. The internal client performs no authz and skips the Enterprise license gate
 *    (manual actions are not Enterprise-gated), so callers MUST still enforce endpoint
 *    privileges via `getEndpointAuthz(request)` with the same privilege the equivalent HTTP
 *    route requires (`withEndpointAuthz(...)`), which carries the license floor.
 */
export type GetInternalResponseActionsClientOptions = {
  spaceId: string;
  agentType?: ResponseActionAgentType;
  /** Used with background task and needed for `UnsecuredActionsClient`  */
  taskId?: string;
  /** Used with background task and needed for `UnsecuredActionsClient`  */
  taskType?: string;
} & (
  | { isAutomated?: true; username?: string; request?: undefined }
  | { isAutomated: false; request: KibanaRequest; username?: undefined }
);

/**
 * A singleton that holds shared services that are initialized during the start up phase
 * of the plugin lifecycle. And stop during the stop phase, if needed.
 */
export class EndpointAppContextService {
  private setupDependencies: EndpointAppContextServiceSetupContract | null = null;
  private startDependencies: EndpointAppContextServiceDependencies | null = null;
  private fleetServicesFactory: EndpointFleetServicesFactoryInterface | null = null;
  private savedObjectsFactoryService: SavedObjectsClientFactory | null = null;
  private readonly ccsCache = new SimpleMemCache({ ttl: CCS_CACHE_TTL_SECONDS });

  public security: Pick<SecurityServiceStart, 'authc'> | undefined;

  public setup(dependencies: EndpointAppContextServiceSetupContract) {
    this.setupDependencies = dependencies;
  }

  /**
   * Wires the dependencies the response actions need: the clients and services they read, with no
   * side effect on anything else (no Fleet callback, no extension point, no index template). Kibana's
   * `start()` calls it, and so does a task process, where Kibana is the only one that installs and
   * registers.
   */
  public initialize(dependencies: EndpointAppContextServiceInitializeContract) {
    if (!this.setupDependencies) {
      throw new EndpointAppContentServicesNotSetUpError();
    }

    this.startDependencies = dependencies;
    this.security = dependencies.security;

    setYaraLogger(this.createLogger('libyara'));

    const isScriptsLibraryEnabled =
      dependencies.experimentalFeatures.responseActionsScriptLibraryManagement;

    if (isScriptsLibraryEnabled) {
      SavedObjectsClientFactory.addSavedObjectHiddenType(SCRIPTS_LIBRARY_SAVED_OBJECT_TYPE);
    }

    const savedObjectsFactory = new SavedObjectsClientFactory(
      dependencies.savedObjectsServiceStart
    );

    this.savedObjectsFactoryService = savedObjectsFactory;
    this.fleetServicesFactory = new EndpointFleetServicesFactory(
      dependencies.fleetStartServices,
      savedObjectsFactory,
      this.createLogger('endpointFleetServices')
    );
  }

  /**
   * What Kibana does on start besides wiring: registers with Fleet and the lists plugin, and
   * installs the scripts library index templates. Must be called after `initialize()`.
   */
  public startSideEffects() {
    if (!this.startDependencies) {
      throw new EndpointAppContentServicesNotStartedError();
    }

    this.registerFleetExtensions();
    this.registerListsExtensions();

    // Setup scripts library
    if (this.startDependencies.experimentalFeatures.responseActionsScriptLibraryManagement) {
      const scriptsLogger = this.createLogger('scriptsLibrarySetup');
      installScriptsLibraryIndexTemplates({
        esClient: this.getInternalEsClient(),
        logger: scriptsLogger,
      }).catch((e) => {
        scriptsLogger.error(e);
      });
    }
  }

  public start(dependencies: EndpointAppContextServiceStartContract) {
    this.initialize(dependencies);
    this.startSideEffects();
  }

  public stop() {
    setYaraLogger(undefined);
    this.startDependencies = null;
    this.savedObjectsFactoryService = null;
  }

  private registerListsExtensions() {
    if (this.startDependencies?.registerListsServerExtension) {
      registerListsPluginEndpointExtensionPoints(
        this.startDependencies?.registerListsServerExtension,
        this
      );
    }
  }

  private registerFleetExtensions() {
    if (!this.setupDependencies) {
      throw new EndpointAppContentServicesNotSetUpError();
    }
    if (!this.startDependencies) {
      throw new EndpointAppContentServicesNotStartedError();
    }

    const {
      fleetStartServices: { registerExternalCallback: registerFleetCallback },
      manifestManager,
      alerting,
      licenseService,
      telemetryConfigProvider,
      productFeaturesService,
      experimentalFeatures,
    } = this.startDependencies;
    const { securitySolutionRequestContextFactory, cloud } = this.setupDependencies;

    if (
      !registerFleetCallback ||
      !manifestManager ||
      !alerting ||
      !telemetryConfigProvider ||
      !productFeaturesService ||
      !securitySolutionRequestContextFactory ||
      !cloud
    ) {
      throw new EndpointError(
        'Registering the Fleet extensions needs the full Kibana start contract: it is available in Kibana only'
      );
    }

    const logger = this.createLogger('endpointFleetExtension');

    registerFleetCallback(
      'agentPolicyCreate',
      getAgentPolicyCreateCallback(logger, productFeaturesService)
    );
    registerFleetCallback(
      'agentPolicyUpdate',
      getAgentPolicyUpdateCallback(logger, productFeaturesService)
    );

    registerFleetCallback('agentPolicyPostUpdate', getAgentPolicyPostUpdateCallback(this));

    registerFleetCallback(
      'packagePolicyCreate',
      getPackagePolicyCreateCallback(
        logger,
        manifestManager,
        securitySolutionRequestContextFactory,
        alerting,
        licenseService,
        cloud,
        productFeaturesService,
        telemetryConfigProvider,
        experimentalFeatures
      )
    );

    registerFleetCallback('packagePolicyPostCreate', getPackagePolicyPostCreateCallback(this));

    registerFleetCallback(
      'packagePolicyUpdate',
      getPackagePolicyUpdateCallback(this, cloud, productFeaturesService, experimentalFeatures)
    );

    registerFleetCallback('packagePolicyPostUpdate', getPackagePolicyPostUpdateCallback(this));

    registerFleetCallback('packagePolicyPostDelete', getPackagePolicyDeleteCallback(this));
  }

  /**
   * Property providing access to saved objects client factory
   */
  public get savedObjects(): SavedObjectsClientFactory {
    if (!this.savedObjectsFactoryService) {
      throw new EndpointAppContentServicesNotStartedError();
    }

    return this.savedObjectsFactoryService;
  }

  /**
   * Is kibana running in serverless mode
   */
  public isServerless(): boolean {
    if (!this.setupDependencies) {
      throw new EndpointAppContentServicesNotSetUpError();
    }

    return Boolean(this.getCloudSetup().isServerlessEnabled);
  }

  /**
   * Returns `true` when Cross-Cluster Search (CCS) for Elastic Defend should be applied — i.e. the
   * `defendRemoteOutputCcs` feature flag is enabled AND the cluster currently has at least one
   * connected remote cluster. The remote-cluster check is cached (see `CCS_CACHE_TTL_SECONDS`) so
   * callers can derive this at every index-pattern build site without repeatedly hitting
   * `_remote/info` — keeping CCS awareness transparent to the services that read endpoint indices.
   *
   * A transient `remoteInfo()` failure resolves to `false` but is NOT cached, so the next call
   * retries instead of serving a stale `false` that would hide remote endpoints.
   */
  public async isCcsEnabled(): Promise<boolean> {
    if (!this.experimentalFeatures.defendRemoteOutputCcs) {
      return false;
    }

    const cached = this.ccsCache.get<boolean>(CCS_CACHE_KEY);
    if (cached !== undefined) {
      return cached;
    }

    try {
      const hasRemoteClusters = await hasConnectedRemoteClusters(this.getInternalEsClient());
      this.ccsCache.set(CCS_CACHE_KEY, hasRemoteClusters);
      return hasRemoteClusters;
    } catch (error) {
      // Don't cache the failure (so a transient error retries next call), but leave a breadcrumb —
      // otherwise a persistent `_remote/info` failure (e.g. missing privileges on the internal user)
      // is indistinguishable from "no remotes connected" for an operator debugging missing endpoints.
      this.createLogger('isCcsEnabled').debug(
        `Failed to check connected remote clusters; treating CCS as disabled: ${
          error?.stack ?? error
        }`
      );
      return false;
    }
  }

  public getInternalEsClient(): ElasticsearchClient {
    if (!this.startDependencies?.esClient) {
      throw new EndpointAppContentServicesNotStartedError();
    }

    return this.startDependencies.esClient;
  }

  /** `true` when this request can fan out across linked projects via Cross-Project Search */
  public async isCpsActive(request: KibanaRequest): Promise<boolean> {
    if (!this.startDependencies) {
      throw new EndpointAppContentServicesNotStartedError();
    }

    if (!this.startDependencies.isCpsActive) {
      throw new EndpointAppContentServicesKibanaOnlyError('isCpsActive');
    }

    return this.startDependencies.isCpsActive(request);
  }

  /**
   * `true` when this particular read fans out. Background callers hold no request identity, so they
   * stay origin-only even with CPS on, and must keep the pre-CPS space semantics along with it:
   * client choice and space filtering have to agree on one answer or a local document can be
   * filtered out of an origin-only read.
   */
  public async isCpsRead(request?: KibanaRequest): Promise<boolean> {
    if (this.startDependencies == null) {
      throw new EndpointAppContentServicesNotStartedError();
    }

    // Resolved before `isCpsActive`, because whether this deployment could fan out at all is only
    // knowable per request now, and a caller with no request identity can never fan out regardless.
    if (!request) {
      this.createLogger('isCpsRead').debug(
        'This read was requested without a KibanaRequest, so it cannot fan out and will return origin data only'
      );

      return false;
    }

    return this.isCpsActive(request);
  }

  /** The client for reads against Defend-owned indices. Fleet-owned ones keep `getInternalEsClient()` */
  public async getReadEsClient(request?: KibanaRequest): Promise<ElasticsearchClient> {
    if (!this.startDependencies) {
      throw new EndpointAppContentServicesNotStartedError();
    }

    if (!this.startDependencies.clusterClient) {
      throw new EndpointAppContentServicesKibanaOnlyError('clusterClient');
    }

    // `isCpsRead` first, so a caller with no request gets its breadcrumb; the second half narrows
    if (!(await this.isCpsRead(request)) || !request) {
      return this.getInternalEsClient();
    }

    return this.startDependencies.clusterClient.asScoped(request, { projectRouting: 'space' })
      .asCurrentUser;
  }

  /**
   * The search client the Defend search strategies dispatch through. Carries the same routing as
   * `getReadEsClient()` when CPS is on, so callers do not branch on the flag themselves.
   */
  public async getScopedSearchClient(request: KibanaRequest): Promise<IScopedSearchClient> {
    if (!this.startDependencies) {
      throw new EndpointAppContentServicesNotStartedError();
    }

    if (!this.startDependencies.dataStart) {
      throw new EndpointAppContentServicesKibanaOnlyError('dataStart');
    }

    const { dataStart } = this.startDependencies;

    return (await this.isCpsActive(request))
      ? dataStart.search.asScoped(request, { projectRouting: 'space' })
      : dataStart.search.asScoped(request);
  }

  /**
   * A request-bound view of the three CPS primitives above, so the services that need them do not
   * have to take a `KibanaRequest` of their own. The server-side services are deliberately detached
   * from the HTTP routing layer; handing them this instead keeps that separation while still making
   * "this read can fan out" visible in their signatures. A service that receives no scoped instance
   * cannot fan out, which is the same rule `isCpsRead` applies to a missing request.
   *
   * This is the async boundary: whether the request can fan out is now per-request and requires an
   * ES round trip, so it is resolved once here and handed to services as a plain boolean. Keeping
   * `ScopedEndpointServices` members synchronous leaves the downstream service signatures untouched.
   *
   * Modelled on `getScopedEndpointArtifactClient()`, which hands out a request-scoped service object
   * in the same way.
   */
  public async asScoped(request: KibanaRequest): Promise<ScopedEndpointServices> {
    const cpsRead = await this.isCpsRead(request);
    const esClient = await this.getReadEsClient(request);
    const searchClient = await this.getScopedSearchClient(request);

    return {
      isCpsRead: () => cpsRead,
      getEsClient: () => esClient,
      getSearchClient: () => searchClient,
      getSpaceId: () => this.getActiveSpaceId(request),
      getSpace: () => this.getActiveSpace(request),
    };
  }

  public getAgentBuilder(): AgentBuilderPluginStart {
    if (!this.startDependencies) {
      throw new EndpointAppContentServicesNotStartedError();
    }

    if (this.startDependencies.agentBuilder == null) {
      throw new EndpointAppContentServicesKibanaOnlyError('agentBuilder');
    }
    return this.startDependencies.agentBuilder;
  }

  private getFleetAuthzService(): FleetStartContract['authz'] {
    const authz = this.startDependencies?.fleetStartServices.authz;

    if (!authz) {
      throw new EndpointAppContentServicesKibanaOnlyError('fleetStartServices.authz');
    }

    return authz;
  }

  public createLogger(...contextParts: string[]) {
    if (!this.setupDependencies?.loggerFactory) {
      throw new EndpointAppContentServicesNotSetUpError();
    }

    return this.setupDependencies.loggerFactory.get(...contextParts);
  }

  /**
   * Username of the authenticated user for a request, or `'unknown'` when the user cannot be
   * resolved (unauthenticated request, security plugin absent, or service not started) — matching
   * the `user?.username || 'unknown'` convention of the response actions HTTP routes. Used to
   * attribute agent-dispatched response actions to the initiating analyst for the audit trail;
   * never returns the system user (`'elastic'`) for an unresolved caller.
   */
  public getCurrentUsername(request: KibanaRequest): string {
    return this.security?.authc.getCurrentUser(request)?.username ?? 'unknown';
  }

  public async getEndpointAuthz(request: KibanaRequest): Promise<EndpointAuthz> {
    if (!this.startDependencies) {
      throw new EndpointAppContentServicesNotStartedError();
    }

    if (!this.startDependencies.productFeaturesService) {
      throw new EndpointAppContentServicesKibanaOnlyError('productFeaturesService');
    }
    const fleetAuthz = await this.getFleetAuthzService().fromRequest(request);
    const userRoles = this.security?.authc.getCurrentUser(request)?.roles ?? [];
    return calculateEndpointAuthz(
      this.getLicenseService(),
      fleetAuthz,
      userRoles,
      this.isServerless(),
      this.startDependencies.productFeaturesService
    );
  }

  public getEndpointMetadataService(spaceId: string = DEFAULT_SPACE_ID): EndpointMetadataService {
    if (this.startDependencies == null) {
      throw new EndpointAppContentServicesNotStartedError();
    }

    return new EndpointMetadataService(this, spaceId);
  }

  /**
   * SpaceId should be defined if wanting go get back an internal client that is scoped to a given space id
   * @param spaceId
   * @param unscoped
   */
  public getInternalFleetServices(
    spaceId?: string,
    unscoped: boolean = false
  ): EndpointInternalFleetServicesInterface {
    if (this.fleetServicesFactory === null) {
      throw new EndpointAppContentServicesNotStartedError();
    }

    return this.fleetServicesFactory.asInternalUser(spaceId, unscoped);
  }

  public getManifestManager(): ManifestManager | undefined {
    return this.startDependencies?.manifestManager;
  }

  public getLicenseService(): LicenseService {
    if (this.startDependencies == null) {
      throw new EndpointAppContentServicesNotStartedError();
    }
    return this.startDependencies.licenseService;
  }

  public getProductFeaturesService(): ProductFeaturesService {
    if (!this.startDependencies) {
      throw new EndpointAppContentServicesNotStartedError();
    }

    if (!this.startDependencies.productFeaturesService) {
      throw new EndpointAppContentServicesKibanaOnlyError('productFeaturesService');
    }
    return this.startDependencies.productFeaturesService;
  }

  public getCloudSetup(): CloudSetup {
    if (!this.setupDependencies) {
      throw new EndpointAppContentServicesNotSetUpError();
    }

    if (!this.setupDependencies.cloud) {
      throw new EndpointAppContentServicesKibanaOnlyError('cloud');
    }

    return this.setupDependencies.cloud;
  }

  public getTelemetryConfigProvider(): TelemetryConfigProvider {
    if (!this.startDependencies) {
      throw new EndpointAppContentServicesNotStartedError();
    }

    if (!this.startDependencies.telemetryConfigProvider) {
      throw new EndpointAppContentServicesKibanaOnlyError('telemetryConfigProvider');
    }

    return this.startDependencies.telemetryConfigProvider;
  }

  public async getCasesClient(req: KibanaRequest): Promise<CasesClient> {
    if (!this.startDependencies) {
      throw new EndpointAppContentServicesNotStartedError();
    }

    if (this.startDependencies.cases == null) {
      throw new EndpointAppContentServicesKibanaOnlyError('cases');
    }
    return this.startDependencies.cases.getCasesClientWithRequest(req);
  }

  public async getRulesClient(req: KibanaRequest): Promise<RulesClientApi> {
    if (!this.startDependencies) {
      throw new EndpointAppContentServicesNotStartedError();
    }

    if (!this.startDependencies.alerting) {
      throw new EndpointAppContentServicesKibanaOnlyError('alerting');
    }
    return this.startDependencies.alerting.getRulesClientWithRequest(req);
  }

  public async getAlertingAuthorization(
    req: KibanaRequest
  ): Promise<PublicMethodsOf<AlertingAuthorization>> {
    if (!this.startDependencies) {
      throw new EndpointAppContentServicesNotStartedError();
    }

    if (!this.startDependencies.alerting) {
      throw new EndpointAppContentServicesKibanaOnlyError('alerting');
    }
    return this.startDependencies.alerting.getAlertingAuthorizationWithRequest(req);
  }

  public getFeatureUsageService(): FeatureUsageService {
    if (this.startDependencies == null) {
      throw new EndpointAppContentServicesNotStartedError();
    }
    return this.startDependencies.featureUsageService;
  }

  public get experimentalFeatures(): ExperimentalFeatures {
    if (this.startDependencies == null) {
      throw new EndpointAppContentServicesNotStartedError();
    }

    return this.startDependencies.experimentalFeatures;
  }

  public getExceptionListsClient(): ExceptionListClient {
    if (!this.startDependencies) {
      throw new EndpointAppContentServicesNotStartedError();
    }

    if (!this.startDependencies.exceptionListsClient) {
      throw new EndpointAppContentServicesKibanaOnlyError('exceptionListsClient');
    }

    return this.startDependencies.exceptionListsClient;
  }

  public getScopedEndpointArtifactClient(
    savedObjectsClient: SavedObjectsClientContract,
    request: KibanaRequest,
    username: string
  ): ScopedEndpointArtifactListClient {
    if (!this.startDependencies?.getExceptionListClient) {
      throw new EndpointError('Endpoint artifact client unavailable: lists plugin is not enabled');
    }

    const client = this.startDependencies.getExceptionListClient(
      savedObjectsClient,
      username,
      false
    );
    return new ScopedEndpointArtifactListClient(client, this, request);
  }

  public getMessageSigningService(): MessageSigningServiceInterface {
    if (!this.startDependencies?.fleetStartServices.messageSigningService) {
      throw new EndpointAppContentServicesNotStartedError();
    }

    return this.startDependencies?.fleetStartServices.messageSigningService;
  }

  public getInternalResponseActionsClient({
    agentType = 'endpoint',
    username = 'elastic',
    taskId,
    taskType,
    spaceId,
    isAutomated = true,
    request,
  }: GetInternalResponseActionsClientOptions): ResponseActionsClient {
    if (!this.startDependencies?.esClient) {
      throw new EndpointAppContentServicesNotStartedError();
    }

    return getResponseActionsClient(agentType, {
      endpointService: this,
      esClient: this.startDependencies.esClient,
      username: isAutomated ? username : this.getCurrentUsername(request as KibanaRequest),
      spaceId,
      isAutomated,
      connectorActions: new NormalizedExternalConnectorClient(
        this.getUnsecuredConnectorActionsClient(),
        this.createLogger('responseActions'),
        {
          spaceId,
          relatedSavedObjects:
            taskId && taskType
              ? [
                  {
                    id: taskId,
                    type: taskType,
                  },
                ]
              : undefined,
        }
      ),
    });
  }

  /** Resolved when a response action first needs it: only Kibana has the actions plugin */
  private getUnsecuredConnectorActionsClient(): IUnsecuredActionsClient {
    const connectorActions = this.startDependencies?.connectorActions;

    if (!connectorActions) {
      const kibanaOnly = () => {
        throw new EndpointAppContentServicesKibanaOnlyError('connectorActions');
      };

      return { execute: kibanaOnly, getAll: kibanaOnly, bulkEnqueueExecution: kibanaOnly };
    }

    return connectorActions.getUnsecuredActionsClient();
  }

  public async getFleetToHostFilesClient() {
    if (!this.startDependencies) {
      throw new EndpointAppContentServicesNotStartedError();
    }

    if (!this.startDependencies.fleetStartServices.createFilesClient) {
      throw new EndpointAppContentServicesKibanaOnlyError('fleetStartServices.createFilesClient');
    }

    return this.startDependencies.fleetStartServices.createFilesClient.toHost(
      'endpoint',
      this.startDependencies.config.maxUploadResponseActionFileBytes
    );
  }

  public async getFleetFromHostFilesClient(): Promise<FleetFromHostFileClientInterface> {
    if (!this.startDependencies) {
      throw new EndpointAppContentServicesNotStartedError();
    }

    if (!this.startDependencies.fleetStartServices.createFilesClient) {
      throw new EndpointAppContentServicesKibanaOnlyError('fleetStartServices.createFilesClient');
    }

    return this.startDependencies.fleetStartServices.createFilesClient.fromHost('endpoint');
  }

  public async getFleetActionsClient(): Promise<FleetActionsClientInterface> {
    if (!this.startDependencies?.fleetStartServices) {
      throw new EndpointAppContentServicesNotStartedError();
    }

    return this.startDependencies.fleetStartServices.createFleetActionsClient('endpoint');
  }

  public getTelemetryService(): Pick<AnalyticsServiceSetup, 'reportEvent'> {
    if (!this.setupDependencies?.telemetry) {
      throw new EndpointAppContentServicesNotSetUpError();
    }
    return this.setupDependencies.telemetry;
  }

  public getActiveSpace(httpRequest: KibanaRequest): Promise<Space> {
    if (!this.startDependencies) {
      throw new EndpointAppContentServicesNotStartedError();
    }

    if (!this.startDependencies.spacesService) {
      throw new EndpointAppContentServicesKibanaOnlyError('spacesService');
    }

    return this.startDependencies.spacesService.getActiveSpace(httpRequest);
  }

  public getActiveSpaceId(httpRequest: KibanaRequest): string {
    if (!this.startDependencies) {
      throw new EndpointAppContentServicesNotStartedError();
    }

    if (!this.startDependencies.spacesService) {
      throw new EndpointAppContentServicesKibanaOnlyError('spacesService');
    }

    return this.startDependencies.spacesService.getSpaceId(httpRequest);
  }

  public getAccessibleSpaces(httpRequest: KibanaRequest): Promise<Space[]> {
    if (!this.startDependencies) {
      throw new EndpointAppContentServicesNotStartedError();
    }

    if (!this.startDependencies.spacesService) {
      throw new EndpointAppContentServicesKibanaOnlyError('spacesService');
    }

    const spacesClient = this.startDependencies.spacesService.createSpacesClient(httpRequest);
    return spacesClient.getAll();
  }

  public getReferenceDataClient(): ReferenceDataClientInterface {
    if (!this.startDependencies?.savedObjectsServiceStart) {
      throw new EndpointAppContentServicesNotStartedError();
    }

    return new ReferenceDataClient(
      this.savedObjects.createInternalScopedSoClient({ readonly: false }),
      this.experimentalFeatures,
      this.createLogger('ReferenceDataClient')
    );
  }

  /**
   * Returns true if Endpoint Exceptions move FF is enabled AND the user has opted in
   * to per-policy Endpoint Exceptions.
   */
  public async isEndpointExceptionsPerPolicyEnabled(): Promise<boolean> {
    if (!this.startDependencies) {
      throw new EndpointAppContentServicesNotStartedError();
    }

    if (!this.startDependencies.experimentalFeatures.endpointExceptionsMovedUnderManagement) {
      return false;
    }

    const referenceDataClient = this.getReferenceDataClient();

    const optInStatusMetadata = await referenceDataClient.get<OptInStatusMetadata>(
      REF_DATA_KEYS.endpointExceptionsPerPolicyOptInStatus
    );

    return optInStatusMetadata.metadata.status;
  }

  public getServerConfigValue<TKey extends keyof ConfigType = keyof ConfigType>(
    key: TKey
  ): ConfigType[TKey] {
    if (!this.startDependencies?.config) {
      throw new EndpointAppContentServicesNotStartedError();
    }

    if (!Object.prototype.hasOwnProperty.call(this.startDependencies.config, key)) {
      throw new EndpointError(`Missing config value for key: ${key}`);
    }

    return this.startDependencies.config[key] as ConfigType[TKey];
  }

  getScriptsLibraryClient(
    spaceId: string,
    username: string,
    rulesClient?: RulesClient
  ): ScriptsLibraryClientInterface {
    return new ScriptsLibraryClient({
      spaceId,
      username,
      endpointService: this,
      rulesClient,
    });
  }
}
