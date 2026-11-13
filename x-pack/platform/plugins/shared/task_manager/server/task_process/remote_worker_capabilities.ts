/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { WorkerCapabilities } from './worker_capabilities';
import type { GetRunCancellation } from './worker_capabilities';
import type { TaskFeatureFlagDefinitions } from './feature_flag_declarations';

export class RemoteWorkerCapabilities extends WorkerCapabilities {
  constructor(
    getCancellation: GetRunCancellation,
    private readonly connectionId: string,
    private readonly getFeatureFlags: (taskType: string) => TaskFeatureFlagDefinitions | undefined
  ) {
    super(getCancellation);
  }

  id(): string {
    return this.connectionId;
  }

  featureFlags(taskType: string): TaskFeatureFlagDefinitions | undefined {
    if (typeof taskType !== 'string' || !taskType || taskType.length > 1024)
      throw new Error('Invalid task type for flag declarations');
    return this.getFeatureFlags(taskType);
  }
}
