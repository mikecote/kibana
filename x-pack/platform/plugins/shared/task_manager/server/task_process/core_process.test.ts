/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { existsSync } from 'fs';
import { dirname } from 'path';
import { firstValueFrom } from 'rxjs';
import { TaskRoot } from '@kbn/core-root-server-internal';
import { defineTaskType } from '../task_type_module';
import { startTaskProcessCore } from './core_process';
import { elasticsearchConfigFromEnv } from './es_config';

jest.mock('@kbn/core-root-server-internal');

describe('failed task Core startup', () => {
  beforeEach(() => jest.clearAllMocks());

  it.each(['preboot', 'setup', 'start'] as const)(
    'closes Core and removes private settings files when %s fails',
    async (phase) => {
      const error = new Error(`Failed ${phase}`);
      jest.mocked(TaskRoot.prototype[phase]).mockRejectedValueOnce(error);

      await expect(
        startTaskProcessCore({
          init: {
            kind: 'init',
            kibanaVersion: '9.6.0',
            authToken: 'test',
            elasticsearch: elasticsearchConfigFromEnv({
              ES_URL: 'http://localhost:9200',
              ES_USERNAME: 'kibana_system',
              ES_PASSWORD: 'test-password',
            }),
          },
          module: defineTaskType({
            type: 'test:startup',
            title: 'Startup test',
            createTaskRunner: () => ({ run: async () => ({ state: {} }) }),
          }),
        })
      ).rejects.toBe(error);

      const root = jest.mocked(TaskRoot).mock.instances[0];
      expect(root.shutdown).toHaveBeenCalledTimes(1);
      const [provider] = jest.mocked(TaskRoot).mock.calls[0];
      const settings = await firstValueFrom(provider.getConfig$());
      expect(existsSync(dirname(settings.path.data))).toBe(false);
    }
  );
});
