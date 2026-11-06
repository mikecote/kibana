/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { BehaviorSubject } from 'rxjs';
import { ConfigService, Env } from '@kbn/config';
import { getEnvOptions } from '@kbn/config-mocks';
import { REPO_ROOT } from '@kbn/repo-info';
import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import { mockRouter } from '@kbn/core-http-router-server-mocks';
import { config } from './http_config';
import { cspConfig } from './csp';
import { externalUrlConfig } from './external_url';
import { permissionsPolicyConfig } from './permissions_policy';
import { TaskHttpService } from './task_http_service';

it('calls the parent with scoped credentials, its base path, and the real self client', async () => {
  const env = Env.createDefault(REPO_ROOT, getEnvOptions());
  const logger = loggingSystemMock.create();
  const configService = new ConfigService(
    {
      getConfig$: () =>
        new BehaviorSubject({
          server: {
            host: '127.0.0.1',
            port: 5601,
            basePath: '/base',
            publicBaseUrl: 'https://parent.example/base',
          },
        }),
    },
    env,
    logger
  );
  for (const descriptor of [config, cspConfig, externalUrlConfig, permissionsPolicyConfig]) {
    configService.setSchema(descriptor.path, descriptor.schema);
  }
  const service = new TaskHttpService({ coreId: Symbol(), configService, env, logger });
  const setup = await service.setup();
  const start = service.start();
  const request = mockRouter.createFakeKibanaRequest({
    spaceId: 'space',
    headers: { authorization: 'ApiKey task-credentials' },
  });
  setup.authRequestHeaders.set(request, { authorization: 'ApiKey task-credentials' });
  const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ ok: true }), {
      headers: { 'content-type': 'application/json' },
    })
  );
  try {
    expect(start.getServerInfo()).toMatchObject({ hostname: '127.0.0.1', port: 5601 });
    expect(start.basePath.serverBasePath).toBe('/base');
    expect(await start.selfClient.asScoped(request).fetch('/api/test')).toEqual({ ok: true });
    const [outbound] = fetchMock.mock.calls[0];
    expect(outbound).toBeInstanceOf(Request);
    if (!(outbound instanceof Request)) throw new Error('Expected an HTTP request');
    expect(outbound.url).toBe('https://parent.example/base/s/space/api/test');
    expect(outbound.headers.get('authorization')).toBe('ApiKey task-credentials');
  } finally {
    fetchMock.mockRestore();
    await service.stop();
  }
});
