/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { createRequire } from 'module';
import { join } from 'path';
import { REPO_ROOT } from '@kbn/repo-info';
import type { EmbeddableContribution } from '@kbn/embeddable-plugin/server/task_process/embeddable_contribution';
import type { TaskTypeModule } from '@kbn/task-manager-plugin/server/task_type_module';
import { taskType } from '@kbn/workflows-execution-engine/server/task_types/workflow_scheduled.task';

const requireContribution = createRequire(__filename);
const { resolveTaskContributions } = requireContribution(
  join(REPO_ROOT, 'src/dev/task_bundles/build')
) as {
  resolveTaskContributions: (module: TaskTypeModule) => Record<string, string[]>;
};

export const nativeEmbeddableContributions = resolveTaskContributions(taskType).embeddables.map(
  (file) => (requireContribution(file) as { contribution: EmbeddableContribution }).contribution
);
