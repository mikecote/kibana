/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { SIGNIFICANT_EVENTS_REQUIRED_PLUGINS } from '../../common';
import {
  createSignificantEventsRegistrationState,
  getSignificantEventsTaskProcessSettings,
} from './significant_events_task_process_settings';

describe('significant events dispatch snapshots', () => {
  it('copies successful registrations so later flag flips cannot change an earlier dispatch', () => {
    const registrations = createSignificantEventsRegistrationState();
    registrations.toolIds.add('second');
    registrations.toolIds.add('first');
    const availability = {
      deploymentSupported: true,
      pricingTierAvailable: true,
      requiredPlugins: [...SIGNIFICANT_EVENTS_REQUIRED_PLUGINS],
    };
    const first = getSignificantEventsTaskProcessSettings({
      registrations,
      availability,
      cpsEnabled: true,
    });
    registrations.skillIds.add('newly-registered-skill');
    availability.pricingTierAvailable = false;
    availability.requiredPlugins.pop();
    const second = getSignificantEventsTaskProcessSettings({
      registrations,
      availability,
      cpsEnabled: false,
    });
    expect(first.registrations.toolIds).toEqual(['first', 'second']);
    expect(first.registrations.skillIds).toEqual([]);
    expect(first.availability.pricingTierAvailable).toBe(true);
    expect(first.availability.requiredPlugins).toEqual([...SIGNIFICANT_EVENTS_REQUIRED_PLUGINS]);
    expect(second.registrations.skillIds).toEqual(['newly-registered-skill']);
    expect(second.availability.pricingTierAvailable).toBe(false);
    expect(first.cpsEnabled).toBe(true);
    expect(second.cpsEnabled).toBe(false);
  });
});
