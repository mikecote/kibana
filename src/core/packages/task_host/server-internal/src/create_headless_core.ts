/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { Container, ContainerModule } from 'inversify';
import {
  CoreStart,
  ElasticsearchClient,
  InternalElasticsearchClient,
  Request,
  ScopedClusterClient,
  ScopedClusterClientFactory,
} from '@kbn/core-di-server';
import type { Logger, LogLevelId } from '@kbn/logging';
import { createElasticsearchCore } from './es_cluster';
import { enrichPodFakeRequest } from './request_users';
import { PodLogger } from './logger';
import { POD_KIBANA_VERSION } from './version';

export interface HeadlessCoreOptions {
  /** kibana.yml-shaped config: `POD_CONFIG`, the keystore, defaults. */
  config: Record<string, unknown>;
  logLevel?: LogLevelId;
}

/**
 * What a task process gets from Core without booting Core: a JSON logger, Core's own Elasticsearch
 * `ClusterClient`, and an inversify container with Core's request-scoped Elasticsearch bindings.
 * Everything heavier (saved objects, security, ui settings) is created on first use through
 * {@link HeadlessCore.getSavedObjects} so a task that does not need it never loads it.
 */
export interface HeadlessCore {
  readonly config: Record<string, unknown>;
  readonly logger: Logger;
  readonly kibanaVersion: string;
  readonly container: Container;
  readonly elasticsearch: ReturnType<typeof createElasticsearchCore>;
  /** Binds the user Task Manager resolved for a run to its fake request. */
  readonly enrichFakeRequest: typeof enrichPodFakeRequest;
  stop(): Promise<void>;
}

export const createHeadlessCore = async ({
  config,
  logLevel = 'info',
}: HeadlessCoreOptions): Promise<HeadlessCore> => {
  const logger = new PodLogger('taskProcess', logLevel);
  const kibanaVersion = POD_KIBANA_VERSION;
  const elasticsearch = createElasticsearchCore({ logger, kibanaVersion, podConfig: config });

  const container = new Container({ defaultScope: 'Singleton' });
  const { Logger: LoggerToken, LoggerFactory } = await import('@kbn/core-di');
  container.bind(CoreStart('elasticsearch')).toConstantValue(elasticsearch.start as never);
  container
    .bind(LoggerFactory)
    .toConstantValue({ get: (...parts: string[]) => logger.get(...parts) } as never);
  container.bind(LoggerToken).toConstantValue(logger as never);

  // Core's request-scoped Elasticsearch bindings (`@kbn/core-di-server-internal`), without the
  // rest of its modules: a task's fake request selects the user, the internal client needs none.
  container.load(
    new ContainerModule(({ bind }) => {
      bind(ScopedClusterClientFactory)
        .toResolvedValue(
          (elasticsearchStart, request) => (options) =>
            elasticsearchStart.client.asScoped(request, options),
          [CoreStart('elasticsearch'), Request]
        )
        .inRequestScope();
      bind(ScopedClusterClient)
        .toResolvedValue((factory) => factory(), [ScopedClusterClientFactory])
        .inRequestScope();
      bind(ElasticsearchClient)
        .toResolvedValue((scoped) => scoped.asCurrentUser, [ScopedClusterClient])
        .inRequestScope();
      bind(InternalElasticsearchClient)
        .toResolvedValue(
          (elasticsearchStart) => elasticsearchStart.client.asInternalUser,
          [CoreStart('elasticsearch')]
        )
        .inSingletonScope();
    })
  );

  return {
    config,
    logger,
    kibanaVersion,
    container,
    elasticsearch,
    enrichFakeRequest: enrichPodFakeRequest,
    stop: async () => {
      await container.unbindAllAsync();
      await elasticsearch.stop();
    },
  };
};
