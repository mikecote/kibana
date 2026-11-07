/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { asSpaceId } from '@kbn/core-spaces-common';
import { httpServerMock, loggingSystemMock } from '@kbn/core/server/mocks';
import { ConfigSchema as spacesConfigSchema } from '@kbn/spaces-plugin/server/config';
import { createMlTaskSpaceCapabilities } from './create_ml_task_space_capabilities';

const capabilities = { navLinks: {}, management: {}, catalogue: {}, ml: { canGetJobs: true } };

describe('createMlTaskSpaceCapabilities', () => {
  const logger = loggingSystemMock.createLogger();

  it('reads native services only when a request is resolved', async () => {
    const getActiveSpace = jest.fn(async () => ({
      id: asSpaceId('default'),
      name: 'Default',
      disabledFeatures: [],
    }));
    const getSpaces = jest.fn(async () => ({ spacesService: { getActiveSpace } }));
    const getSettings = jest.fn(() => ({
      config: spacesConfigSchema.validate({}, { offering: 'traditional' }),
      buildFlavor: 'traditional' as const,
      features: [],
      cpsEnabled: false,
    }));
    const switcher = createMlTaskSpaceCapabilities({ logger }, getSpaces, getSettings);
    expect(getSpaces).not.toHaveBeenCalled();
    expect(getSettings).not.toHaveBeenCalled();
    const request = httpServerMock.createKibanaRequest();
    await expect(switcher(request, capabilities, false)).resolves.toEqual(capabilities);
    expect(getActiveSpace).toHaveBeenCalledWith(request);
  });

  it('does not turn missing dispatch settings into enabled capabilities', async () => {
    const switcher = createMlTaskSpaceCapabilities({ logger }, jest.fn(), () => {
      throw new Error('Missing native Spaces settings');
    });
    await expect(
      switcher(httpServerMock.createKibanaRequest(), capabilities, false)
    ).rejects.toThrow('Missing native Spaces settings');
  });
});
