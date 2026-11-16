/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { materializeTaskProcessInstrumentationFiles } from './instrumentation_files';
import { readTaskProcessInit } from './main_init';
import { applyTaskProcessInstrumentationEnvironment } from './instrumentation_environment';
import type { TaskProcessInstrumentation } from './instrumentation';
import { createTaskProcessParentWatcher } from './parent_watch';
import type { TaskProcessInit } from './wire';

export { readTaskProcessInit } from './main_init';
export { createTaskProcessParentWatcher } from './parent_watch';

/**
 * Initializes native tracing from an `init` the caller already has, registering its shutdown to run
 * before the process exits. Split from `bootstrapTaskProcess` so the generated entry can import the
 * task module and its contributions concurrently with each other once instrumentation is in place,
 * rather than one at a time.
 */
export const instrumentFromInit = async (
  init: TaskProcessInit,
  registerStop: ReturnType<typeof createTaskProcessParentWatcher>
): Promise<TaskProcessInstrumentation | undefined> => {
  if (!init.instrumentation) return undefined;
  const material = materializeTaskProcessInstrumentationFiles(init.instrumentation);
  try {
    applyTaskProcessInstrumentationEnvironment(material.instrumentation.environment);
    const { initializeTaskProcessInstrumentation } = await import('./instrumentation');
    const native = await initializeTaskProcessInstrumentation({
      ...init.instrumentation,
      ...material.instrumentation,
    });
    let shutdownPromise: Promise<void> | undefined;
    const instrumentation: TaskProcessInstrumentation = {
      forceFlush: native.forceFlush,
      collectMetrics: native.collectMetrics,
      collectGauges: native.collectGauges,
      shutdown: () =>
        (shutdownPromise ??= (async () => {
          try {
            await native.shutdown();
          } finally {
            material.cleanup();
          }
        })()),
    };
    registerStop(instrumentation.shutdown);
    return instrumentation;
  } catch (error) {
    material.cleanup();
    throw error;
  }
};

/**
 * Initializes native tracing before importing any task implementation or its Core services. The
 * generated entry inlines this same sequence (`readTaskProcessInit`, then `instrumentFromInit`, then
 * the module imports); kept for other callers that want it as one call.
 */
export const bootstrapTaskProcess = async (): Promise<{
  init: TaskProcessInit;
  instrumentation?: TaskProcessInstrumentation;
  registerStop: ReturnType<typeof createTaskProcessParentWatcher>;
}> => {
  const registerStop = createTaskProcessParentWatcher();
  const init = await readTaskProcessInit();
  const instrumentation = await instrumentFromInit(init, registerStop);
  return { init, instrumentation, registerStop };
};
