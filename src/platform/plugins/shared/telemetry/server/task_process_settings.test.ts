/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { getTaskProcessSettings } from './task_process_settings';

describe('getTaskProcessSettings', () => {
  const config = {
    sendUsageTo: 'staging' as const,
    appendServerlessChannelsSuffix: false,
    labels: { branch: 'main' },
  };

  it('sends the opt-in status, where usage goes and the labels', () => {
    expect(getTaskProcessSettings({ config, isOptedIn: true })).toEqual({
      optIn: true,
      sendUsageTo: 'staging',
      snapshotUrl: expect.stringContaining('telemetry-staging.elastic.co'),
      labels: { branch: 'main' },
    });
  });

  it('leaves the opt-in out while Kibana does not know it', () => {
    expect(getTaskProcessSettings({ config })).toEqual({
      sendUsageTo: 'staging',
      snapshotUrl: expect.any(String),
      labels: { branch: 'main' },
    });
  });
});
