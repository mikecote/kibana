/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { RemoteRunObserver } from '@kbn/task-manager-plugin/server/task';
import type { InMemoryMetrics } from '../monitoring/in_memory_metrics';
import { IN_MEMORY_METRICS } from '../monitoring/in_memory_metrics';

/**
 * Counts, in Kibana's memory, the rule runs that a task process served, exactly as the task runner
 * counts the runs it does itself (`TaskRunner`), from what Kibana sees of the end of a run:
 *
 * - a run that ended counts as an execution, unless Kibana cancelled it for its timeout;
 * - it also counts as a failure when the result carries a `taskRunError`, which `TaskRunner` sets
 *   when the rule threw or reported an error, which is when its own outcome is `failure`;
 * - a run Kibana cancelled while the process had it counts as a timeout, once.
 *
 * The `node_rules` usage collector reads these counters from Kibana, which is where they must be.
 */
export const observeRemoteRuleRun = (
  getMetrics: () => Promise<Pick<InMemoryMetrics, 'increment'>>
): RemoteRunObserver => {
  const increment = (...metrics: IN_MEMORY_METRICS[]) => {
    void getMetrics().then(
      (inMemoryMetrics) => metrics.forEach((metric) => inMemoryMetrics.increment(metric)),
      () => undefined
    );
  };
  return {
    onResult: (result) => {
      const failed = !!(result as { taskRunError?: unknown } | undefined)?.taskRunError;
      increment(
        IN_MEMORY_METRICS.RULE_EXECUTIONS,
        ...(failed ? [IN_MEMORY_METRICS.RULE_FAILURES] : [])
      );
    },
    onCancel: () => increment(IN_MEMORY_METRICS.RULE_TIMEOUTS),
  };
};
