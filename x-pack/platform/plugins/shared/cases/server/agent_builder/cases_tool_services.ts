/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { CoreSetup, CoreStart, KibanaRequest } from '@kbn/core/server';
import type { Space } from '@kbn/spaces-plugin/server';
import type { CasesServerStartDependencies } from '../types';

export interface CasesToolServices {
  getBasePath: () => Promise<
    Pick<CoreStart['http']['basePath'], 'publicBaseUrl' | 'serverBasePath'>
  >;
  getActiveSpace: (request: KibanaRequest) => Promise<Space | undefined>;
}

/** Adapts native Kibana services to the request and link ports used by Cases tools. */
export const createCasesToolServices = (
  core: Pick<CoreSetup<CasesServerStartDependencies>, 'getStartServices'>
): CasesToolServices => ({
  getBasePath: async () => {
    const [coreStart] = await core.getStartServices();
    return coreStart.http.basePath;
  },
  getActiveSpace: async (request) => {
    const [, plugins] = await core.getStartServices();
    return plugins.spaces?.spacesService.getActiveSpace(request);
  },
});
