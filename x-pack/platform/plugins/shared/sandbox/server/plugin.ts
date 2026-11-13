/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type {
  CoreSetup,
  CoreStart,
  KibanaRequest,
  Logger,
  Plugin,
  PluginInitializerContext,
} from '@kbn/core/server';
import type { SpacesPluginStart } from '@kbn/spaces-plugin/server';
import type { WorkflowsExtensionsServerPluginSetup } from '@kbn/workflows-extensions/server';
import type { SandboxPluginConfig } from './config';
import type { SandboxSession } from './sandbox_session';
import { readTlsCredentials } from './tls_credentials';
import type { SandboxTlsCredentials } from './tls_credentials';
import { createSandboxRunServices } from './create_sandbox_run_services';
import type { SandboxRunServices } from './create_sandbox_run_services';
import {
  SANDBOX_TASK_PROCESS_SETTINGS_ID,
  getSandboxTaskProcessSettings,
} from './task_process_settings';

interface SandboxPluginSetupDeps {
  workflowsExtensions?: WorkflowsExtensionsServerPluginSetup;
}

interface SandboxPluginStartDeps {
  spaces?: SpacesPluginStart;
}

/**
 * Setup contract for the Sandbox plugin.
 *
 * Available in your plugin's `setup` deps when `sandbox` is declared as an
 * optional plugin. Use `isAvailable` to gate registration of sandbox-dependent
 * features so they are absent (rather than present-but-erroring) in deployments
 * where the sandbox is not configured.
 */
export interface SandboxPluginSetup {
  /** `true` when `xpack.sandbox.enabled` is `true` and `api_key` is present in config. */
  readonly isAvailable: boolean;
}

/**
 * Start contract for the Sandbox plugin.
 *
 * Obtain this from your plugin's `start` dependencies after declaring `sandbox`
 * as an optional plugin in `kibana.jsonc`:
 *
 * ```ts
 * // kibana.jsonc
 * { "plugin": { "optionalPlugins": ["sandbox"] } }
 *
 * // server/types.ts
 * import type { SandboxPluginStart } from '@kbn/sandbox-plugin/server';
 * interface MyPluginStartDeps { sandbox?: SandboxPluginStart; }
 *
 * // server/plugin.ts — typical usage inside a tool handler
 * start(_core, { sandbox }) {
 *   const getSandbox = () => sandbox;
 *   // inside a tool handler:
 *   try {
 *     const session = getSandbox()?.getSession(request, sessionId);
 *   } catch (err) {
 *     // sandbox plugin present but not configured in this deployment
 *   }
 * }
 * ```
 *
 * Note that `sandbox` itself is `undefined` when the plugin is not installed.
 * When it is installed but not configured (missing `api_key`, or
 * `xpack.sandbox.enabled: false`), `getSession` throws a descriptive error.
 */
export interface SandboxPluginStart {
  /**
   * Returns a {@link SandboxSession} for the given request + session ID.
   *
   * The space is derived automatically from the request. Sessions are created
   * lazily and cached for the lifetime of the plugin: the same
   * `(spaceId, sessionId)` pair always returns the same session object.
   * Pod allocation happens transparently on the first RPC.
   *
   * @throws {Error} When the sandbox is not configured in this deployment
   *   (`xpack.sandbox.enabled: false`, or missing `api_key`).
   */
  getSession(request: KibanaRequest, sessionId: string): SandboxSession;

  /**
   * Returns a {@link SandboxSession} for an explicit space ID + session ID.
   *
   * Use this when no `KibanaRequest` is available (e.g. workflow step handlers).
   * Sessions are cached by `(spaceId, sessionId)` exactly like {@link getSession}.
   *
   * @throws {Error} When the sandbox is not configured in this deployment.
   */
  getSessionForSpace(spaceId: string, sessionId: string): SandboxSession;
}

export class SandboxPlugin
  implements
    Plugin<SandboxPluginSetup, SandboxPluginStart, SandboxPluginSetupDeps, SandboxPluginStartDeps>
{
  private readonly logger: Logger;
  private runServices?: SandboxRunServices;
  private spacesEnabled = false;
  private tlsCredentials?: SandboxTlsCredentials;

  constructor(private readonly ctx: PluginInitializerContext<SandboxPluginConfig>) {
    this.logger = ctx.logger.get();
  }

  setup(_core: CoreSetup, plugins: SandboxPluginSetupDeps): SandboxPluginSetup {
    plugins.workflowsExtensions?.registerTaskProcessSettings(SANDBOX_TASK_PROCESS_SETTINGS_ID, () =>
      getSandboxTaskProcessSettings(this.ctx.config.get(), this.tlsCredentials, this.spacesEnabled)
    );
    const config = this.ctx.config.get();
    if (config.enabled) {
      this.tlsCredentials = readTlsCredentials(config.ssl);
      if (!this.tlsCredentials.clientCertPem) {
        this.logger.info(
          'xpack.sandbox.ssl.certificate is not set — connecting to sandbox-api without mTLS, authenticated by api_key only'
        );
      }
    }
    return {
      isAvailable: config.enabled && !!config.api_key,
    };
  }

  start(_core: CoreStart, { spaces }: SandboxPluginStartDeps): SandboxPluginStart {
    this.spacesEnabled = Boolean(spaces);
    this.runServices = createSandboxRunServices({
      config: this.ctx.config.get(),
      tlsCredentials: this.tlsCredentials,
      spaces: spaces?.spacesService,
      logger: this.logger,
    });
    return this.runServices.sandbox;
  }

  stop(): void {
    this.runServices?.stop();
  }
}
