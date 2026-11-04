/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { RunContext } from '@kbn/task-manager-plugin/server';
import type { RuleRunRuntime, TaskRunnerContext } from './types';
import { AD_HOC_RUN_SAVED_OBJECT_TYPE, RULE_SAVED_OBJECT_TYPE } from '../saved_objects';
import { AdHocTaskRunner } from './ad_hoc_task_runner';

export class TaskRunnerFactory {
  private isInitialized = false;
  private taskRunnerContext?: TaskRunnerContext;
  private resolveRuntime!: (runtime: RuleRunRuntime) => void;
  private readonly runtime = new Promise<RuleRunRuntime>((resolve) => {
    this.resolveRuntime = resolve;
  });

  public initialize(taskRunnerContext: TaskRunnerContext) {
    if (this.isInitialized) {
      throw new Error('TaskRunnerFactory already initialized');
    }
    this.isInitialized = true;
    this.taskRunnerContext = taskRunnerContext;
    this.resolveRuntime(taskRunnerContext);
  }

  /**
   * What a rule run needs, once the plugin has started. The task type of every rule type awaits it
   * when a run is created, so no run starts before the services it uses exist.
   */
  public getRuntime(): Promise<RuleRunRuntime> {
    return this.runtime;
  }

  public createAdHoc({ taskInstance, executionUuid }: RunContext) {
    if (!this.isInitialized) {
      throw new Error('TaskRunnerFactory not initialized');
    }

    return new AdHocTaskRunner({
      taskInstance,
      executionUuid,
      context: this.taskRunnerContext!,
      internalSavedObjectsRepository: this.taskRunnerContext!.savedObjects.createInternalRepository(
        [RULE_SAVED_OBJECT_TYPE, AD_HOC_RUN_SAVED_OBJECT_TYPE]
      ),
    });
  }
}
