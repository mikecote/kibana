/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { buildTaskBundle, getTaskBundleEntries, writeManifest } from '../../task_bundles/build';
import { validateBundleLimits } from '../../task_bundles/limits';
import type { Task } from '../lib';

/**
 * Bundles every task type module declared in a plugin's `kibana.jsonc` (`plugin.taskTypes`) into
 * `task_bundles/`, and fails the build when one contains an input task processes must not load or
 * is over its byte limit. `bin/kibana-task` and Kibana's `task_processes` run them from there.
 */
export const BuildTaskBundles: Task = {
  description: 'Bundling task types to run in their own processes',

  async run(config, log, build) {
    const outDir = build.resolvePath('task_bundles');
    const version = config.getBuildVersion();
    const results = await Promise.all(
      getTaskBundleEntries().map((entry) =>
        buildTaskBundle({ entry, outDir, kibanaVersion: version })
      )
    );

    const forbidden = results.flatMap(({ name, forbidden: hits }) =>
      hits.map(
        (hit: { id: string; reason: string; chain: string[] }) =>
          `${name}: ${hit.id} (${hit.reason})\n    ${hit.chain.join('\n    ')}`
      )
    );
    const limitErrors = validateBundleLimits(results);
    if (forbidden.length || limitErrors.length) {
      throw new Error(`Task bundles are not valid:\n${[...forbidden, ...limitErrors].join('\n')}`);
    }

    writeManifest(results, outDir);
    log.info(`Bundled ${results.length} task types into ${outDir}`);
  },
};
