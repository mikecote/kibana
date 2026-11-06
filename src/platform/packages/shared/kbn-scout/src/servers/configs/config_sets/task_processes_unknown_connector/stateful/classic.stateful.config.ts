/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { resolve } from 'path';
import { REPO_ROOT } from '@kbn/repo-info';
import { createTaskProcessesServers } from '../../task_processes/shared';

/**
 * The `task_processes` config set with a test plugin that registers connector types no task bundle
 * knows (`test.not-enabled`, `test.single_file_connector`), so every run in a process is declined.
 */
export const servers = createTaskProcessesServers([
  `--plugin-path=${resolve(
    REPO_ROOT,
    'x-pack/platform/test/alerting_api_integration/common/plugins/actions_simulators'
  )}`,
]);
