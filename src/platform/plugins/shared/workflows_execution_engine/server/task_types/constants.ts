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
/** The telemetry channel a task process hands its metering records to Kibana on. */
export const WORKFLOWS_METERING_TELEMETRY_KIND = 'workflows.metering';
/** The contribution keys of the plugins that add connector types and workflow steps to a task process. */
export const RULE_RUN_CONTRIBUTIONS_KEY = 'alerting-rule-run';
export const WORKFLOW_STEPS_CONTRIBUTIONS_KEY = 'workflow-steps';
