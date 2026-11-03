/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { readFileSync } from 'fs';
import { parse } from 'yaml';
import { PodLogger } from '@kbn/core-task-host-server-internal';
import { bootUnit } from './boot_unit';
import type { NeedsSpec, TaskTypeModule } from './task_type';
import { startPodServer } from '../task_pod/host/server';

/** Accepts both `xpack.alerting_v2.x: 1` and nested yml, like kibana.yml does. */
const nestDottedKeys = (flat: Record<string, unknown>): Record<string, unknown> => {
  const nested: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(flat)) {
    const parts = key.split('.');
    let cursor = nested;
    parts.slice(0, -1).forEach((part) => {
      cursor = (cursor[part] ??= {}) as Record<string, unknown>;
    });
    cursor[parts[parts.length - 1]] = value;
  }
  return nested;
};

/**
 * Entry of a task process: boots a headless host for the task type and serves `/health`, `/run` and
 * `/cancel` for Task Manager. Env: ES_URL, ES_USERNAME/ES_PASSWORD or ES_API_KEY, PORT, POD_CONFIG
 * (yml with kibana.yml keys), POD_MAX_CONCURRENCY, LOG_LEVEL.
 */
export const runTaskProcess = async (unit: TaskTypeModule<NeedsSpec>) => {
  const logger = new PodLogger('taskProcess');
  try {
    const config = process.env.POD_CONFIG
      ? nestDottedKeys(
          (parse(readFileSync(process.env.POD_CONFIG, 'utf8')) as Record<string, unknown>) ?? {}
        )
      : {};
    const { taskDefinitions, core } = await bootUnit(unit, {
      config,
      logLevel: process.env.LOG_LEVEL as never,
    });
    startPodServer({
      taskDefinitions,
      taskTypes: [unit.type],
      enrichFakeRequest: core.enrichFakeRequest as never,
      port: Number(process.env.PORT ?? 0),
    });
  } catch (error) {
    logger.fatal(`failed to start ${unit.type}: ${(error as Error).stack ?? String(error)}`);
    process.exit(1);
  }
};
