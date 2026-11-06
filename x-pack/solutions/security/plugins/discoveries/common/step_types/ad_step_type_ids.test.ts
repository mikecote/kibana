/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { AD_STEP_TYPE_IDS } from './ad_step_type_ids';

describe('AD_STEP_TYPE_IDS', () => {
  it('lists every step type the plugin registers', () => {
    expect([...AD_STEP_TYPE_IDS].sort()).toEqual([
      'security.attack-discovery.defaultAlertRetrieval',
      'security.attack-discovery.defaultValidation',
      'security.attack-discovery.generate',
      'security.attack-discovery.persistDiscoveries',
      'security.attack-discovery.run',
    ]);
  });
});
