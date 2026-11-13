/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

export const MODERN_MONITOR_ID = '48c6c014-97ec-4f21-8878-90f22410cb87';
export const LEGACY_MONITOR_ID = '2c2fc6fb-3c4c-408d-b4ab-66ada82e6154';

export const createMonitorAttributes = (name: string) => ({
  name,
  type: 'http',
  enabled: true,
  schedule: { number: '3', unit: 'm' },
  locations: [{ id: 'us-east', label: 'US East' }],
  tags: ['production'],
  secrets: JSON.stringify({ password: 'worker-monitor-secret' }),
});
