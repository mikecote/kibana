/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { of } from 'rxjs';

import { schema } from '@kbn/config-schema';
import type { CoreSetup, KibanaRequest, PluginInitializer } from '@kbn/core/server';
import { PluginType } from '@kbn/core-base-common';
import type { StaticPlugin } from '@kbn/core-plugins-server-internal';
import type { CoreSecurityDelegateContract } from '@kbn/core-security-server';
import { License } from '@kbn/licensing-plugin/common/license';
import type { ILicense } from '@kbn/licensing-types';
import type { AuditServiceSetup } from '@kbn/security-plugin-types-server';
import type { SpacesPluginSetup } from '@kbn/spaces-plugin/server';
import { getTaskProcessContext } from '@kbn/task-manager-plugin/server/task_process/context';
import { reviveSettings } from '@kbn/task-manager-plugin/server/task_process/settings';

import { AuditService } from './audit/audit_service';
import { buildSecurityApi } from './build_delegate_apis';
import type { ConfigType, UiamConfigType } from './config';
import type { RunTimeSecurity } from './run_time_security';
import { createRunTimeSecurity } from './run_time_security';
import { setupSavedObjects } from './saved_objects';
import type { AuthenticatedUser, SecurityLicense } from '../common';
import { SecurityLicenseService } from '../common/licensing/license_service';

/**
 * What the security plugin sends to a task process, by `getTaskProcessSettings`. Only what a run
 * reads of the validated config, plus what the plugin derives from its environment.
 */
export interface SecurityTaskProcessSettings {
  /** The license as Kibana knows it, so that the process checks runs against the same one. */
  license?: ReturnType<License['toJSON']>;
  uiam?: UiamConfigType;
  audit: ConfigType['audit'];
  serviceAccounts: { enabled: boolean };
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
}: {
  license?: ILicense;
  config: Pick<ConfigType, 'uiam' | 'audit' | 'serviceAccounts'>;
  applicationName: string;
  kibanaServerResourceURL: string;
  elasticsearchUrl?: string;
}): SecurityTaskProcessSettings => ({
  license: license ? (license as License).toJSON() : undefined,
  uiam: config.uiam,
  audit: config.audit,
  serviceAccounts: { enabled: config.serviceAccounts.enabled },
  applicationName,
  kibanaServerResourceURL,
  elasticsearchUrl,
});

/** What the security task plugin returns from `start`, as `host.plugins.security`. */
export type SecurityTaskPluginStart = Pick<RunTimeSecurity, 'authc' | 'authz'> & {
  audit: AuditServiceSetup;
};

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

const plugin: PluginInitializer<void, SecurityTaskPluginStart> = async (initializerContext) => {
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
  // A process has no session: the user is what the run's fake request was enriched with, which the
  // delegate reads the same way, so this must not go back through the delegate.
  const getCurrentUser = (request: KibanaRequest) =>
    (request as { auth?: { credentials?: AuthenticatedUser } }).auth?.credentials ?? null;
  let runTime: RunTimeSecurity | undefined;
  const getRunTime = () => {
    if (!runTime) throw new Error('The security services are not available before Core starts');
    return runTime;
  };

  return {
    setup(core: CoreSetup) {
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
        getAuthc: () => getRunTime().authc,
        getSession: () => ({ getSID: async () => undefined }),
        getServiceAccounts: () => null,
        audit,
        config,
        logger,
      });
      core.security.registerSecurityDelegate(delegate);
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

    start(core) {
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
        },
        audit: auditSetup!,
        getCurrentUser,
      });
      const { authc, authz, audit } = runTime;
      return { authc, authz, audit };
    },
  };
};

/**
 * The security plugin as a plugin of a task process: Core's security delegate is the plugin's own
 * API keys (including UIAM), privilege checks and audit log, built by the same constructors.
 */
export const createSecurityTaskPlugin = (kibanaVersion: string): StaticPlugin => ({
  manifest: {
    id: 'security',
    version: kibanaVersion,
    kibanaVersion,
    type: PluginType.standard,
    configPath: ['xpack', 'security'],
    requiredPlugins: [],
    optionalPlugins: [],
    requiredBundles: [],
    runtimePluginDependencies: [],
    server: true,
    ui: false,
    owner: { name: 'Kibana Security', githubTeam: 'kibana-security' },
  },
  definition: { config: { schema: configSchema }, plugin: plugin as never },
});
