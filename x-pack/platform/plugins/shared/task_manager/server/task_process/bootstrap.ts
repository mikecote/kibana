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

/** Initializes native tracing before importing any task implementation or its Core services. */
export const bootstrapTaskProcess = async (): Promise<{
  init: TaskProcessInit;
  instrumentation?: TaskProcessInstrumentation;
  registerStop: ReturnType<typeof createTaskProcessParentWatcher>;
}> => {
  const registerStop = createTaskProcessParentWatcher();
  const init = await readTaskProcessInit();
  let instrumentation: TaskProcessInstrumentation | undefined;
  if (init.instrumentation) {
    const material = materializeTaskProcessInstrumentationFiles(init.instrumentation);
    try {
      applyTaskProcessInstrumentationEnvironment(material.instrumentation.environment);
      const { initializeTaskProcessInstrumentation } = await import('./instrumentation');
      const native = await initializeTaskProcessInstrumentation({
        ...init.instrumentation,
        ...material.instrumentation,
      });
      let shutdownPromise: Promise<void> | undefined;
      instrumentation = {
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
    } catch (error) {
      material.cleanup();
      throw error;
    }
  }
  if (instrumentation) registerStop(instrumentation.shutdown);
  return { init, instrumentation, registerStop };
};
