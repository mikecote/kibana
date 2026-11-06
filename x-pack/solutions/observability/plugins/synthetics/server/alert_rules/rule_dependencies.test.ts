/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { createRuleTypeHostMock } from '@kbn/alerting-plugin/server/task_types/rule_task_type.mocks';
import { createSyntheticsRuleTaskType } from '../task_types/synthetics_rule_task_type';
import { registerSyntheticsStatusCheckRule } from './status_rule/monitor_status_rule';
import { getSyntheticsTaskProcessSettings } from './rule_dependencies';

describe('getSyntheticsTaskProcessSettings', () => {
  const config = { service: { manifestUrl: 'https://manifest.test', username: 'secret' } };

  it('sends the access status and public locations Kibana has, and no credential', () => {
    const locations = [{ id: 'us_central', label: 'US Central', url: 'https://us' }];
    const settings = getSyntheticsTaskProcessSettings({
      config: config as never,
      isCpsEnabled: true,
      serviceManagedLocations: {
        isAllowed: false,
        locations: locations as never,
        throttling: { enabled: true } as never,
        // Not part of what is sent.
        ...({ httpClient: { secret: 'x' } } as object),
      } as never,
    });
    expect(settings).toEqual({
      service: { manifestUrl: 'https://manifest.test', devUrl: undefined },
      isCpsEnabled: true,
      serviceManagedLocations: {
        isAllowed: false,
        locations,
        throttling: { enabled: true },
      },
    });
  });

  it('sends nothing for locations before the service has set them up', () => {
    expect(
      getSyntheticsTaskProcessSettings({ config: config as never, isCpsEnabled: false })
    ).not.toHaveProperty('serviceManagedLocations');
  });
});

describe('the synthetics rule module', () => {
  it('builds the rule type with the locations Kibana sent, not an allowed empty list', () => {
    const register = jest.fn(registerSyntheticsStatusCheckRule);
    const taskType = createSyntheticsRuleTaskType(
      'xpack.synthetics.alerts.monitorStatus',
      register
    );
    const serviceManagedLocations = { isAllowed: false, locations: [], throttling: undefined };
    taskType.buildRuleType(
      createRuleTypeHostMock({
        synthetics: { service: {}, isCpsEnabled: false, serviceManagedLocations },
        observability: { unsafe: { alertDetails: { uptime: { enabled: true } } } },
      }) as never
    );
    expect(register.mock.calls[0][2]).toMatchObject({ serviceManagedLocations });
  });
});
