/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { coreMock, httpServerMock, savedObjectsRepositoryMock } from '@kbn/core/server/mocks';
import { asSpaceId } from '@kbn/core-spaces-common';
import { loggerMock } from '@kbn/logging-mocks';
import { securityMock } from '@kbn/security-plugin/server/mocks';
import { ConfigSchema } from '@kbn/spaces-plugin/server/config';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import { createWorkflowSpacesServices } from './spaces_runtime_contribution';

const setup = () => {
  const core = coreMock.createStart();
  const repository = savedObjectsRepositoryMock.create();
  core.savedObjects.createScopedRepository.mockReturnValue(repository);
  core.savedObjects.createInternalRepository.mockReturnValue(repository);
  const security = securityMock.createSetup();
  security.authz.mode.useRbacForRequest.mockReturnValue(false);
  const host: TaskHost = {
    logger: loggerMock.create(),
    elasticsearch: core.elasticsearch.client,
    savedObjects: core.savedObjects,
    security: core.security,
    executionContext: core.executionContext,
    http: core.http,
    analytics: core.analytics,
    server: { uuid: 'server-1', version: '9.9.9', buildNum: 1, isServerless: false },
    plugins: { security },
    settings: {
      spacesRuntime: {
        config: ConfigSchema.validate({}, { offering: 'traditional' }),
        buildFlavor: 'traditional',
        features: [
          {
            id: 'hidden_feature',
            name: 'Observability feature',
            app: [],
            category: { id: 'observability', label: 'Observability', order: 1 },
            privileges: { all: { savedObject: { all: [], read: [] }, ui: [] } },
          },
        ],
        cpsEnabled: false,
      },
    },
  };
  return { host, core, repository, security };
};

describe('spaces run services', () => {
  it('reads the stored space, solution and disabled features on each request', async () => {
    const { host, repository } = setup();
    const request = httpServerMock.createKibanaRequest({ spaceId: asSpaceId('other') });
    repository.get.mockResolvedValue({
      id: 'other',
      type: 'space',
      references: [],
      attributes: {
        name: 'Stored space',
        disabledFeatures: ['hidden_feature'],
        solution: 'security',
      },
    });
    const services = createWorkflowSpacesServices(host);
    await expect(services.spacesService.getActiveSpace(request)).resolves.toMatchObject({
      id: 'other',
      name: 'Stored space',
      solution: 'security',
      disabledFeatures: ['hidden_feature'],
    });
    expect(repository.get).toHaveBeenCalledWith('space', 'other');
    repository.get.mockResolvedValue({
      id: 'other',
      type: 'space',
      references: [],
      attributes: {
        name: 'Updated space',
        disabledFeatures: [],
        solution: 'oblt',
      },
    });
    await expect(services.spacesService.getActiveSpace(request)).resolves.toMatchObject({
      name: 'Updated space',
      solution: 'oblt',
      disabledFeatures: [],
    });
  });

  it('checks space privileges before reading the stored space', async () => {
    const { host, repository, security } = setup();
    security.authz.mode.useRbacForRequest.mockReturnValue(true);
    security.authz.checkPrivilegesWithRequest.mockReturnValue({
      atSpace: jest.fn().mockResolvedValue({ hasAllRequested: false }),
    } as never);
    const request = httpServerMock.createKibanaRequest({ spaceId: asSpaceId('other') });
    await expect(
      createWorkflowSpacesServices(host).spacesService.getActiveSpace(request)
    ).rejects.toThrow('Unauthorized');
    expect(repository.get).not.toHaveBeenCalled();
  });

  it('requires the spaces dispatch snapshot', () => {
    const { host } = setup();
    expect(() => createWorkflowSpacesServices({ ...host, settings: {} })).toThrow('settings');
  });
});
