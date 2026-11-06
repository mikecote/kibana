/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import { createTaskRunError, TaskErrorSource } from '@kbn/task-manager-plugin/server/task_running';
import { InMemoryMetrics, IN_MEMORY_METRICS } from '../monitoring/in_memory_metrics';
import { RuleResultService } from '../monitoring/rule_result_service';
import { asErr, asOk } from '../lib/result_type';
import { getTaskRunError, processRunResults } from '../task_runner/lib';
import { observeRemoteRuleRun } from './remote_run_metrics';

describe('observeRemoteRuleRun', () => {
  const setup = () => {
    const metrics = new InMemoryMetrics(loggingSystemMock.createLogger());
    return {
      metrics,
      observer: observeRemoteRuleRun(async () => metrics),
      read: async () => {
        await new Promise((resolve) => setImmediate(resolve));
        return {
          executions: metrics.getInMemoryMetric(IN_MEMORY_METRICS.RULE_EXECUTIONS),
          failures: metrics.getInMemoryMetric(IN_MEMORY_METRICS.RULE_FAILURES),
          timeouts: metrics.getInMemoryMetric(IN_MEMORY_METRICS.RULE_TIMEOUTS),
        };
      },
    };
  };

  it('counts a run that ended well as an execution', async () => {
    const { observer, read } = setup();
    observer.onResult?.({ state: {} });
    expect(await read()).toEqual({ executions: 1, failures: 0, timeouts: 0 });
  });

  it('counts a run whose result carries a task run error as an execution and a failure', async () => {
    const { observer, read } = setup();
    observer.onResult?.({
      state: {},
      taskRunError: createTaskRunError(new Error('rule failed'), TaskErrorSource.USER),
    });
    expect(await read()).toEqual({ executions: 1, failures: 1, timeouts: 0 });
  });

  it('counts a run without a result (nothing to reschedule) as an execution', async () => {
    const { observer, read } = setup();
    observer.onResult?.(undefined);
    expect(await read()).toEqual({ executions: 1, failures: 0, timeouts: 0 });
  });

  it('counts a cancelled run as a timeout and not as an execution', async () => {
    const { observer, read } = setup();
    observer.onCancel?.();
    expect(await read()).toEqual({ executions: 0, failures: 0, timeouts: 1 });
  });

  it('does not throw when the metrics are not available', async () => {
    const observer = observeRemoteRuleRun(() => Promise.reject(new Error('no runtime')));
    expect(() => observer.onResult?.({ state: {} })).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
  });
});

describe('what Kibana can see of a run: its task run error', () => {
  // `TaskRunner` counts a failure when the outcome of the run is `failure`; Kibana sees only the
  // result, whose `taskRunError` is built from the same run result. They must agree for every kind.
  const logger = loggingSystemMock.createLogger();
  const metrics = {
    numSearches: 0,
    totalSearchDurationMs: 0,
    esSearchDurationMs: 0,
    numberOfTriggeredActions: 0,
    numberOfGeneratedActions: 0,
    numberOfActiveAlerts: 0,
    numberOfRecoveredAlerts: 0,
    numberOfNewAlerts: 0,
    hasReachedAlertLimit: false,
    hasReachedQueuedActionsLimit: false,
    triggeredActionsStatus: 'complete',
  } as never;

  const outcomeAndError = (
    runRuleResult: Parameters<typeof processRunResults>[0]['runRuleResult'],
    setup: (service: RuleResultService) => void = () => undefined
  ) => {
    const result = new RuleResultService();
    setup(result);
    const { outcome } = processRunResults({
      logger,
      logPrefix: 'rule',
      result,
      runDate: new Date(),
      runRuleResult,
    });
    const { taskRunError } = getTaskRunError({
      runRuleResult,
      logger,
      ruleResult: result,
      ruleTypeId: 'test',
      ruleId: '1',
    }) as { taskRunError?: Error };
    return { outcome, failed: !!taskRunError };
  };

  it('has a task run error exactly when the outcome is a failure', () => {
    const ok = asOk({ state: {}, metrics });
    expect(outcomeAndError(ok)).toEqual({ outcome: 'success', failed: false });
    expect(outcomeAndError(asErr(new Error('threw')))).toEqual({
      outcome: 'failure',
      failed: true,
    });
    expect(
      outcomeAndError(ok, (service) => service.getLastRunSetters().addLastRunError('reported'))
    ).toEqual({ outcome: 'failure', failed: true });
    expect(
      outcomeAndError(ok, (service) => service.getLastRunSetters().addLastRunWarning('warned'))
    ).toEqual({ outcome: 'success', failed: false });
  });
});
