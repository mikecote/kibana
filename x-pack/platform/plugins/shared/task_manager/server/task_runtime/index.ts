/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

/**
 * Task type modules: one importable unit per Task Manager task type that runs the same in Kibana
 * and in a task process. Import from `@kbn/task-manager-plugin/server/task_runtime`.
 */
export { defineServiceModule, defineTaskType } from './task_type';
export type {
  NeedsSpec,
  ResolvedNeeds,
  ServiceModule,
  TaskTypeDefinition,
  TaskTypeModule,
} from './task_type';
export { registerTaskType } from './register_task_type';
export type { ServicesProvider } from './register_task_type';
