/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { firstValueFrom } from 'rxjs';
import type { CoreContext } from '@kbn/core-base-server-internal';
import type { HttpServerInfo } from '@kbn/core-http-server';
import { AuthHeadersStorage } from './auth_headers_storage';
import { BasePath } from './base_path_service';
import { HttpConfig, type HttpConfigType } from './http_config';
import { cspConfig, type CspConfigType } from './csp';
import { externalUrlConfig, type ExternalUrlConfig } from './external_url';
import { permissionsPolicyConfig, type PermissionsPolicyConfigType } from './permissions_policy';
import {
  createInternalHttpSelfClient,
  type InternalHttpSelfService,
  type SelfClientUiamAttestationGetter,
} from './self_client';
import type { InternalHttpServiceSetup, InternalHttpServiceStart } from './types';

type TaskHttpSetup = Pick<InternalHttpServiceSetup, 'authRequestHeaders' | 'config'>;
type TaskHttpStart = Pick<
  InternalHttpServiceStart,
  'basePath' | 'getServerInfo' | 'selfClient' | 'setSelfClientUiamAttestationGetter'
>;

/** Core's outbound HTTP services, without constructing an inbound server. */
export class TaskHttpService {
  private readonly authRequestHeaders = new AuthHeadersStorage();
  private config?: HttpConfig;
  private selfClient?: InternalHttpSelfService;
  private uiamAttestationGetter?: SelfClientUiamAttestationGetter;

  constructor(private readonly core: CoreContext) {}

  public async setup(): Promise<TaskHttpSetup> {
    const configService = this.core.configService;
    const [http, csp, externalUrl, permissionsPolicy] = await Promise.all([
      firstValueFrom(configService.atPath<HttpConfigType>('server')),
      firstValueFrom(configService.atPath<CspConfigType>(cspConfig.path)),
      firstValueFrom(configService.atPath<ExternalUrlConfig>(externalUrlConfig.path)),
      firstValueFrom(
        configService.atPath<PermissionsPolicyConfigType>(permissionsPolicyConfig.path)
      ),
    ]);
    this.config = new HttpConfig(http, csp, externalUrl, permissionsPolicy);
    return { config: this.config, authRequestHeaders: this.authRequestHeaders };
  }

  public start(): TaskHttpStart {
    const config = this.config;
    if (!config) throw new Error('Task HTTP services must be set up before start.');
    const basePath = new BasePath(config.basePath, config.publicBaseUrl);
    const getServerInfo = (): HttpServerInfo => ({
      name: config.name,
      hostname: config.host,
      port: config.port,
      protocol: config.ssl.enabled ? 'https' : 'http',
    });
    this.selfClient = createInternalHttpSelfClient({
      authRequestHeaders: this.authRequestHeaders,
      basePath,
      getServerInfo,
      getHttpConfig: () => config,
      kibanaVersion: this.core.env.packageInfo.version,
      log: this.core.logger.get('http', 'self-client'),
      target: config.selfHttp.target,
      getUiamAttestationGetter: () => this.uiamAttestationGetter,
    });
    return {
      basePath,
      getServerInfo,
      selfClient: this.selfClient,
      setSelfClientUiamAttestationGetter: (getter) => {
        this.uiamAttestationGetter = getter;
      },
    };
  }

  public async stop(): Promise<void> {
    await this.selfClient?.close();
    this.selfClient = undefined;
  }
}
