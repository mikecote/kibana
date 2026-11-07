/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

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
    applyTaskProcessInstrumentationEnvironment(init.instrumentation.environment);
    const { initializeTaskProcessInstrumentation } = await import('./instrumentation');
    instrumentation = await initializeTaskProcessInstrumentation(init.instrumentation);
  }
  if (instrumentation) registerStop(instrumentation.shutdown);
  return { init, instrumentation, registerStop };
};
