/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { CloudSetup } from '@kbn/cloud-plugin/server';
import type { UsageRecord } from '@kbn/usage-api-plugin/server';
import type { EsWorkflowExecution } from '@kbn/workflows';
import { ExecutionStatus, isTerminalStatus, pickManagedWorkflowFields } from '@kbn/workflows';
import { BUCKET_SIZE_MS, METERING_SOURCE_ID, WORKFLOWS_USAGE_TYPE } from './constants';

/** The cloud fields a metering record is built from. */
export type WorkflowMeteringCloud = Pick<
  CloudSetup,
  'serverless' | 'deploymentId' | 'csp' | 'region' | 'elasticsearchClusterId'
>;

/**
 * A metering record is a plain, serializable object: a task process hands it to Kibana as telemetry
 * and Kibana sends it, while Kibana itself sends it straight to the Usage API.
 */
export type WorkflowMeteringRecord = UsageRecord;

/**
 * Where a record goes. Fire-and-forget: a sink never throws and never blocks the run. Kibana's sink
 * sends the record to the Usage API; a task process forwards it to Kibana through its host.
 */
export interface MeteringSink {
  report(record: WorkflowMeteringRecord): void;
}

/**
 * Builds the usage record (Usage Record Schema v2) of a finished workflow execution, or `undefined`
 * when nothing is to be metered: self-managed (no project or deployment id), a non-terminal
 * execution, or a SKIPPED one (dropped by concurrency limits, it never ran).
 *
 * Kibana (stage 1) sends raw data; the transform function (stage 3) decides what is billable.
 */
export const buildWorkflowMeteringRecord = (
  execution: EsWorkflowExecution,
  cloudSetup?: WorkflowMeteringCloud
): WorkflowMeteringRecord | undefined => {
  const projectId = cloudSetup?.serverless?.projectId;
  const deploymentId = cloudSetup?.deploymentId;
  const instanceGroupId = projectId || deploymentId;
  const instanceGroupType: NonNullable<UsageRecord['source']['instance_group_type']> = projectId
    ? 'serverless_project'
    : 'stateful_deployment';

  // Self-managed: no metering (no projectId or deploymentId available)
  if (!instanceGroupId) {
    return undefined;
  }

  if (!isTerminalStatus(execution.status as ExecutionStatus)) {
    return undefined;
  }
  if (execution.status === ExecutionStatus.SKIPPED) {
    return undefined;
  }

  const durationMs = execution.duration || 0;
  const durationMinutes = Math.ceil(durationMs / 60000);
  const normalizedQuantity = Math.max(1, Math.ceil(durationMs / BUCKET_SIZE_MS));
  const stepTypes = extractStepTypes(execution);
  const stepCount = Object.values(stepTypes).reduce((sum, count) => sum + count, 0);

  const managedWorkflowFields = pickManagedWorkflowFields(execution);

  const metadata: Record<string, string> = {
    duration_ms: String(durationMs),
    duration_minutes: String(durationMinutes),
    normalized_quantity: String(normalizedQuantity),
    status: execution.status,
    triggered_by: execution.triggeredBy || 'unknown',
    is_test_run: String(execution.isTestRun),
    is_managed: String(managedWorkflowFields.managed === true),
    is_billable: String(
      managedWorkflowFields.managed !== true || managedWorkflowFields.billable === true
    ),
    workflow_id: execution.workflowId,
    space_id: execution.spaceId,
    step_count: String(stepCount),
  };

  if (managedWorkflowFields.managedBy !== undefined) {
    metadata.managed_by = managedWorkflowFields.managedBy;
  }

  if (managedWorkflowFields.originManagedWorkflowId !== undefined) {
    metadata.origin_managed_workflow_id = managedWorkflowFields.originManagedWorkflowId;
  }

  if (Object.keys(stepTypes).length > 0) {
    metadata.step_types = JSON.stringify(stepTypes);
  }

  const source: UsageRecord['source'] = {
    id: METERING_SOURCE_ID,
    instance_group_id: instanceGroupId,
    instance_group_type: instanceGroupType,
  };

  if (instanceGroupType !== 'serverless_project') {
    source.provider = cloudSetup?.csp;
    source.region = cloudSetup?.region;

    const clusterId = cloudSetup?.elasticsearchClusterId;
    if (clusterId) {
      source.metadata = { cluster_id: clusterId };
    }
  }

  return {
    id: `workflow-execution-${execution.id}`,
    usage_timestamp: execution.finishedAt || new Date().toISOString(),
    creation_timestamp: new Date().toISOString(),
    usage: {
      type: WORKFLOWS_USAGE_TYPE,
      quantity: 1,
      period_seconds: Math.ceil(durationMs / 1000) || 1,
      metadata,
    },
    source,
  };
};

/**
 * Extracts a breakdown of step types from the workflow definition.
 * Returns a map of step type -> count (e.g., { connector: 5, transform: 3, ai: 2 }).
 */
const extractStepTypes = (execution: EsWorkflowExecution): Record<string, number> => {
  const stepTypes: Record<string, number> = {};

  const steps = execution.workflowDefinition?.steps;
  if (!steps || !Array.isArray(steps)) {
    return stepTypes;
  }

  for (const step of steps) {
    const stepType = step?.type || 'unknown';
    stepTypes[stepType] = (stepTypes[stepType] || 0) + 1;
  }

  return stepTypes;
};

/** What the run path calls once a run ends: builds the record and hands it to the sink. */
export interface WorkflowsMeteringReporter {
  reportWorkflowExecution(
    execution: EsWorkflowExecution,
    cloudSetup?: WorkflowMeteringCloud
  ): Promise<void>;
}

/** A reporter over a sink; the record is built here, whoever sends it. */
export const createWorkflowsMeteringReporter = (sink: MeteringSink): WorkflowsMeteringReporter => ({
  reportWorkflowExecution: async (execution, cloudSetup) => {
    const record = buildWorkflowMeteringRecord(execution, cloudSetup);
    if (record) {
      sink.report(record);
    }
  },
});
