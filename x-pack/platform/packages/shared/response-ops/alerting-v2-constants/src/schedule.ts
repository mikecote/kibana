/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

/** Minimum allowed interval for schedule.every */
export const MIN_SCHEDULE_INTERVAL = '5s';

/**
 * Default value of `xpack.alerting_v2.rules.minimumScheduleInterval`. Shared
 * between the server config (as its `defaultValue`) and the rule form UI so the
 * client validates `schedule.every` against the same minimum the server enforces
 * on a default deployment.
 */
export const DEFAULT_MINIMUM_SCHEDULE_INTERVAL = '1m';
