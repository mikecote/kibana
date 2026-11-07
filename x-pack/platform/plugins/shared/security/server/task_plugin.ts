/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { of } from 'rxjs';

import { schema } from '@kbn/config-schema';
import type { KibanaRequest } from '@kbn/core/server';
import { PluginType } from '@kbn/core-base-common';
import type {
  TaskCoreSetup as CoreSetup,
  TaskPluginInitializer,
  TaskStaticPlugin,
} from '@kbn/core-plugins-server-internal';
import type {
  CoreSecurityDelegateContract,
  CoreSecurityDelegateServiceAccounts,
} from '@kbn/core-security-server';
import type {
  EncryptedSavedObjectsPluginSetup,
  EncryptedSavedObjectsPluginStart,
} from '@kbn/encrypted-saved-objects-plugin/server';
import { License } from '@kbn/licensing-plugin/common/license';
import type { ILicense } from '@kbn/licensing-types';
import type { AuditServiceSetup } from '@kbn/security-plugin-types-server';
import type { SpacesPluginSetup } from '@kbn/spaces-plugin/server';
import { getTaskProcessContext } from '@kbn/task-manager-plugin/server/task_process/context';
import { reviveSettings } from '@kbn/task-manager-plugin/server/task_process/settings';

import { AuditService } from './audit/audit_service';
import { buildSecurityApi, buildUserProfileApi } from './build_delegate_apis';
import type { ConfigType, UiamConfigType } from './config';
import type { RunTimeSecurity } from './run_time_security';
import { createRunTimeSecurity } from './run_time_security';
import { setupSavedObjects } from './saved_objects';
import type { CloudProjectContext, ServiceAccountsServiceStart } from './service_accounts';
import {
  registerServiceAccountCredentialSavedObjectType,
  registerWorkloadBindingSavedObjectType,
  ServiceAccountsService,
} from './service_accounts';
import type { UiamTlsMaterial } from './uiam';
import { readUiamTlsMaterial } from './uiam';
import type { UserProfileServiceStartInternal } from './user_profile/user_profile_service';
import { UserProfileService } from './user_profile/user_profile_service';
import type { AuthenticatedUser, SecurityLicense } from '../common';
import { SecurityLicenseService } from '../common/licensing/license_service';

/**
 * What the security plugin sends to a task process, by `getTaskProcessSettings`. Only what a run
 * reads of the validated config, plus what the plugin derives from its environment.
 */
export interface SecurityTaskProcessSettings {
  /** The license as Kibana knows it, so that the process checks runs against the same one. */
  license?: ReturnType<License['toJSON']>;
  /** The UIAM config without the paths of its TLS files: a process may not have them. */
  uiam?: UiamConfigType;
  /** The contents of the files `xpack.security.uiam.ssl` names, so that a remote process can connect. */
  uiamTls?: UiamTlsMaterial;
  audit: ConfigType['audit'];
  fipsMode: ConfigType['fipsMode'];
  serviceAccounts: {
    enabled: boolean;
    requestLifetime: ConfigType['serviceAccounts']['requestLifetime'];
  };
  /** The project the Kibana is of, which the UIAM service accounts are created in (serverless). */
  cloudProjectContext?: CloudProjectContext;
  /** The application the Kibana privileges are registered under in Elasticsearch. */
  applicationName: string;
  kibanaServerResourceURL: string;
  elasticsearchUrl?: string;
}

/**
 * The settings a task process is started with, to register with Task Manager under the plugin id
 * `security`. They are plain data: durations are revived on the other side.
 */
export const getTaskProcessSettings = ({
  license,
  config,
  applicationName,
  kibanaServerResourceURL,
  elasticsearchUrl,
  cloudProjectContext,
}: {
  license?: ILicense;
  config: Pick<ConfigType, 'uiam' | 'audit' | 'serviceAccounts' | 'fipsMode'>;
  applicationName: string;
  kibanaServerResourceURL: string;
  elasticsearchUrl?: string;
  cloudProjectContext?: CloudProjectContext;
}): SecurityTaskProcessSettings => ({
  license: license ? (license as License).toJSON() : undefined,
  uiam: config.uiam?.enabled
    ? { ...config.uiam, ssl: { verificationMode: config.uiam.ssl.verificationMode } }
    : config.uiam,
  uiamTls: config.uiam?.enabled ? readUiamTlsMaterial(config.uiam.ssl) : undefined,
  audit: config.audit,
  fipsMode: config.fipsMode,
  serviceAccounts: {
    enabled: config.serviceAccounts.enabled,
    requestLifetime: config.serviceAccounts.requestLifetime,
  },
  cloudProjectContext,
  applicationName,
  kibanaServerResourceURL,
  elasticsearchUrl,
});

/** What the security task plugin returns from `start`, as `host.plugins.security`. */
export type SecurityTaskPluginStart = Pick<RunTimeSecurity, 'authc' | 'authz'> & {
  userProfile: UserProfileServiceStartInternal;
  audit: AuditServiceSetup;
  /** The service accounts of the plugin, when they are enabled and the process can serve them. */
  serviceAccounts: ServiceAccountsServiceStart | null;
};

interface SetupDeps {
  /** Optional: only a module that declares encrypted saved objects has it. Service accounts need it. */
  encryptedSavedObjects?: EncryptedSavedObjectsPluginSetup;
}

interface StartDeps {
  encryptedSavedObjects?: EncryptedSavedObjectsPluginStart;
}

// Core reads `xpack.security.uiam` from the raw config, to authenticate its Elasticsearch client with
// UIAM. The rest of the settings reach the plugin through the task process context.
const uiamSchema = schema.object(
  {
    enabled: schema.boolean({ defaultValue: false }),
    sharedSecret: schema.maybe(schema.string()),
  },
  { unknowns: 'allow' }
);
type SpaceId = ReturnType<SpacesPluginSetup['spacesService']['getSpaceId']>;

const configSchema = schema.object({ uiam: schema.maybe(uiamSchema) }, { unknowns: 'allow' });

const plugin: TaskPluginInitializer<void, SecurityTaskPluginStart, SetupDeps, StartDeps> = async (
  initializerContext
) => {
  const settings = reviveSettings(
    getTaskProcessContext().init.settings?.security ?? null
  ) as SecurityTaskProcessSettings | null;
  if (!settings) throw new Error('The task process was not given the settings of: security');

  const logger = initializerContext.logger.get();
  const { buildFlavor, version: kibanaVersion } = initializerContext.env.packageInfo;
  const config = {
    uiam: settings.uiam,
    audit: settings.audit,
    serviceAccounts: settings.serviceAccounts,
  };

  let license: SecurityLicense | undefined;
  let auditSetup: AuditServiceSetup | undefined;
  let delegate: CoreSecurityDelegateContract | undefined;
  // The delegate adds trusted task identity over this base authentication state without recursion.
  const getUnenrichedUser = (request: KibanaRequest) =>
    (request as { auth?: { credentials?: AuthenticatedUser } }).auth?.credentials ?? null;
  const getCurrentUser = (request: KibanaRequest): AuthenticatedUser | null => {
    if (!delegate) throw new Error('The security task delegate has not initialized');
    return delegate.authc.getCurrentUser(request);
  };
  let runTime: RunTimeSecurity | undefined;
  let workloadTypes: CoreSecurityDelegateServiceAccounts | undefined;
  let serviceAccounts: ServiceAccountsServiceStart | null = null;
  let userProfile: UserProfileServiceStartInternal | undefined;
  let canEncrypt = false;
  // Whether this process serves service accounts, which Core reports through the delegate.
  let serviceAccountsAvailable = false;
  const getRunTime = () => {
    if (!runTime) throw new Error('The security services are not available before Core starts');
    return runTime;
  };

  return {
    setup(core: CoreSetup, deps: SetupDeps) {
      // The license Kibana had when it started the process, which is what it checked the run against.
      const rawLicense = settings.license
        ? License.fromJSON(settings.license)
        : new License({ signature: '' });
      license = new SecurityLicenseService().setup({ license$: of(rawLicense) }).license;

      const audit = new AuditService(logger.get('audit')).setup({
        license,
        config: settings.audit,
        logging: core.logging,
        // A task process serves no HTTP requests.
        http: { registerOnPostAuth: () => {} },
        status: core.status,
        isServerless: buildFlavor === 'serverless',
        getCurrentUser,
        getSID: async () => undefined,
        getSpaceId: (request: KibanaRequest) => (request as { spaceId?: SpaceId }).spaceId,
        recordAuditLoggingUsage: () => {},
      });

      delegate = buildSecurityApi({
        getAuthc: () => ({
          apiKeys: getRunTime().authc.apiKeys,
          getCurrentUser: getUnenrichedUser,
        }),
        getSession: () => ({ getSID: async () => undefined }),
        getServiceAccounts: () => serviceAccounts,
        audit,
        config: {
          uiam: config.uiam,
          serviceAccounts: {
            get enabled() {
              return serviceAccountsAvailable;
            },
          },
        },
        logger,
      });
      ({ serviceAccounts: workloadTypes } = core.security.registerSecurityDelegate(delegate));
      core.userProfile.registerUserProfileDelegate(
        buildUserProfileApi({
          getUserProfile: () => {
            if (!userProfile) throw new Error('The task user profile service has not started');
            return userProfile;
          },
        })
      );

      // The two hidden types service accounts keep their bindings and credentials in, registered by
      // the plugin's own functions as in Kibana. Without the encrypted saved objects plugin (a module
      // that declares no encrypted types) service accounts are not offered.
      if (deps.encryptedSavedObjects) {
        canEncrypt = deps.encryptedSavedObjects.canEncrypt;
        registerWorkloadBindingSavedObjectType(core.savedObjects, deps.encryptedSavedObjects);
        registerServiceAccountCredentialSavedObjectType(
          core.savedObjects,
          deps.encryptedSavedObjects
        );
        serviceAccountsAvailable = settings.serviceAccounts.enabled;
      }
      auditSetup = audit;

      // What the plugin registers with saved objects: a scoped client reads and writes with Kibana's
      // own user, after the privileges of the request were checked (as `getRunTime` is only called
      // once a request is served, the authorization it builds from Core's start is there).
      setupSavedObjects({
        audit,
        authz: {
          get mode() {
            return getRunTime().authz.mode;
          },
          get actions() {
            return getRunTime().authz.actions;
          },
          checkSavedObjectsPrivilegesWithRequest: (request) =>
            getRunTime().authz.checkSavedObjectsPrivilegesWithRequest(request),
        },
        savedObjects: core.savedObjects,
        getCurrentUser,
      });
    },

    start(core, deps) {
      runTime = createRunTimeSecurity({
        logger,
        clusterClient: core.elasticsearch.client,
        license: license!,
        config,
        applicationName: settings.applicationName,
        buildFlavor,
        uiam: {
          kibanaServerResourceURL: settings.kibanaServerResourceURL,
          elasticsearchUrl: settings.elasticsearchUrl,
          kibanaVersion,
          tls: settings.uiamTls,
        },
        audit: auditSetup!,
        getCurrentUser,
      });
      const { authc, authz, audit } = runTime;
      const profiles = new UserProfileService(logger.get('user-profile'));
      profiles.setup({ authz, license: license! });
      const profileClient = profiles.start({
        clusterClient: core.elasticsearch.client,
        getCurrentUser,
      });
      userProfile = profileClient;

      if (settings.serviceAccounts.enabled && deps.encryptedSavedObjects && workloadTypes) {
        serviceAccounts = new ServiceAccountsService(logger.get('service-accounts')).start({
          config: { serviceAccounts: settings.serviceAccounts },
          isServerless: buildFlavor === 'serverless',
          license: license!,
          uiam: runTime.uiam,
          checkPrivilegesWithRequest: authz.checkPrivilegesWithRequest,
          audit,
          cloudProjectContext: settings.cloudProjectContext,
          clusterClient: core.elasticsearch.client,
          savedObjects: core.savedObjects,
          encryptedSavedObjects: deps.encryptedSavedObjects,
          canEncrypt,
          getCurrentUser,
          // Only a request that binds a workload reads the profile, which is Kibana's to serve.
          getCurrentUserProfileId: (request) => profileClient.getCurrentProfileId({ request }),
          getSpaceId: (request) => (request as { spaceId?: string }).spaceId ?? 'default',
          workloadTypes,
        });
      } else if (settings.serviceAccounts.enabled) {
        logger.debug(
          'Service accounts are not available: the process has no encrypted saved objects'
        );
      }
      return { authc, authz, audit, serviceAccounts, userProfile };
    },
  };
};

/**
 * The security plugin as a plugin of a task process: Core's security delegate is the plugin's own
 * API keys (including UIAM), privilege checks and audit log, built by the same constructors.
 */
export const createSecurityTaskPlugin = (kibanaVersion: string): TaskStaticPlugin => ({
  manifest: {
    id: 'security',
    version: kibanaVersion,
    kibanaVersion,
    type: PluginType.standard,
    configPath: ['xpack', 'security'],
    requiredPlugins: [],
    optionalPlugins: ['encryptedSavedObjects'],
    requiredBundles: [],
    runtimePluginDependencies: [],
    server: true,
    ui: false,
    owner: { name: 'Kibana Security', githubTeam: 'kibana-security' },
  },
  definition: { config: { schema: configSchema }, taskPlugin: plugin },
});
