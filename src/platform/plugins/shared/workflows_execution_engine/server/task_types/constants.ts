/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

/** The id the config of the engine is sent to a task process under. */
export const WORKFLOWS_ENGINE_SETTINGS_ID = 'workflowsExecutionEngine';
/** The id the cloud fields of the engine (links to Kibana, metering) are sent to a task process under. */
export const WORKFLOWS_ENGINE_CLOUD_SETTINGS_ID = 'workflowsExecutionEngineCloud';
/**
 * The id the Usage API connection (url and TLS) is sent to a task process under, so that the process
 * reports metering itself. Absent when Kibana does not report metering.
 */
export const WORKFLOWS_USAGE_API_SETTINGS_ID = 'workflowsUsageApi';
/** The contribution keys of the plugins that add connector types and workflow steps to a task process. */
export const RULE_RUN_CONTRIBUTIONS_KEY = 'alerting-rule-run';
export const WORKFLOW_STEPS_CONTRIBUTIONS_KEY = 'workflow-steps';
