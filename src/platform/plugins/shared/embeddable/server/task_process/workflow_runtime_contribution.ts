/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import type { WorkflowStepsContribution } from '@kbn/workflows-extensions/server';
import { createNativeEmbeddables } from './create_native_embeddables';
import {
  EMBEDDABLE_CONTRIBUTIONS_KEY,
  EMBEDDABLE_RUNTIME_SETTINGS_ID,
} from './embeddable_contribution';
import type { EmbeddableContribution, EmbeddableRegistrationIds } from './embeddable_contribution';

export const contribution: WorkflowStepsContribution = {
  declares: {
    contributionKeys: [EMBEDDABLE_CONTRIBUTIONS_KEY],
    settings: [EMBEDDABLE_RUNTIME_SETTINGS_ID],
  },
  provides: {
    embeddable: ({ host, settings }) => {
      const taskHost = host as TaskHost;
      const expected = settings[EMBEDDABLE_RUNTIME_SETTINGS_ID] as
        | EmbeddableRegistrationIds
        | undefined;
      if (!expected) throw new Error('Native embeddables require Main registration metadata');
      return createNativeEmbeddables(
        (taskHost.contributions?.[EMBEDDABLE_CONTRIBUTIONS_KEY] ?? []) as EmbeddableContribution[],
        expected,
        { featureFlags: taskHost.featureFlags }
      ).start;
    },
  },
  register: (_registry, { settings, services, registerRunCheck }) => {
    if (!settings[EMBEDDABLE_RUNTIME_SETTINGS_ID]) return;
    if (!registerRunCheck) throw new Error('Native embeddables require execution checks');
    registerRunCheck(() => {
      if (!services) throw new Error('Native embeddables require execution services');
      services.getService('embeddable');
      return undefined;
    });
  },
};
