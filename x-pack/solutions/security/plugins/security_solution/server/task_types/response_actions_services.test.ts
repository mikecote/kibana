/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import { createMockConfig } from '../config.mock';
import { getTaskProcessSettings } from '../config';
import { getResponseActionsServices } from './response_actions_services';

const create = (endpointExceptionsMovedUnderManagement: boolean) => {
  const config = createMockConfig();
  return getResponseActionsServices({
    host: { savedObjects: { createInternalRepository: jest.fn() } } as never,
    logger: loggingSystemMock.createLogger(),
    kibanaVersion: '9.9.9',
    settings: {
      securitySolution: getTaskProcessSettings({
        ...config,
        experimentalFeatures: {
          ...config.experimentalFeatures,
          endpointExceptionsMovedUnderManagement,
        },
      }),
    },
  });
};

describe('getResponseActionsServices', () => {
  it('runs a rule without response actions', async () => {
    const { scheduleNotificationResponseActionsService } = create(false);

    await expect(
      scheduleNotificationResponseActionsService({
        signals: [{}],
        signalsCount: 1,
        responseActions: undefined,
      })
    ).resolves.toBeUndefined();
    await expect(
      scheduleNotificationResponseActionsService({
        signals: [],
        signalsCount: 0,
        responseActions: [],
      })
    ).resolves.toBeUndefined();
  });

  it('starts the response action services only when a rule has response actions to run', async () => {
    const { scheduleNotificationResponseActionsService } = create(false);

    // Without the settings of Fleet the build fails, which shows it is attempted only here.
    await expect(
      scheduleNotificationResponseActionsService({
        signals: [{}],
        signalsCount: 1,
        responseActions: [{ actionTypeId: '.endpoint', params: {} }] as never,
      })
    ).rejects.toThrow('was not given the settings of fleet');
  });

  it('answers the per-policy endpoint exceptions opt-in without the endpoint services', async () => {
    const { endpointAppContextService } = create(false);

    await expect(endpointAppContextService.isEndpointExceptionsPerPolicyEnabled()).resolves.toBe(
      false
    );
  });

  it('fails clearly when the rest of the endpoint services is used', () => {
    const { endpointAppContextService } = create(false);

    expect(() => endpointAppContextService.getInternalFleetServices()).toThrow(
      'is only available in Kibana'
    );
  });
});
