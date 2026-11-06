/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { CLIENT_ALERT_TYPES } from '../../common/constants/uptime_alerts';
import { tlsAlertFactory } from '../legacy_uptime/lib/alerts/tls';
import { createUptimeRuleTaskType } from './uptime_rule_task_type';

/** The `CLIENT_ALERT_TYPES.TLS` rule type, which a task process can run. */
export const taskType = createUptimeRuleTaskType(CLIENT_ALERT_TYPES.TLS, tlsAlertFactory as never);
