/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { Logger } from '@kbn/core/server';
import type { UsageReportingService } from '@kbn/usage-api-plugin/server';
import type { EsWorkflowExecution } from '@kbn/workflows';
import type {
  MeteringSink,
  WorkflowMeteringCloud,
  WorkflowMeteringRecord,
} from './build_metering_record';
import { buildWorkflowMeteringRecord } from './build_metering_record';
import { WORKFLOWS_USAGE_TYPE } from './constants';

/**
 * Workflows Metering Service - Stage 1 of the billing pipeline.
 *
 * Builds UsageRecords from completed workflow executions (`buildWorkflowMeteringRecord`) and sends
 * them to the Usage API. Uses event-based metering: reports immediately after
 * each workflow reaches a terminal state (fire-and-forget with inline retry).
 *
 * This is Kibana's {@link MeteringSink}: a task process forwards records to Kibana, which sends
 * them here.
 *
 * Key design decisions:
 * - quantity=1 for each execution (simple count). Transform function decides billing.
 * - Rich metadata (duration, status, step_types, etc.) for flexible pricing logic.
 * - Deduplication via deterministic ID: `workflow-execution-{executionId}`.
 * - Supports both Serverless (projectId) and ECH (deploymentId).
 */
export class WorkflowsMeteringService implements MeteringSink {
  constructor(
    private readonly usageReportingService: UsageReportingService,
    private readonly logger: Logger
  ) {}

  /** Sends a record without waiting for it: all errors are caught and logged. */
  public report(record: WorkflowMeteringRecord): void {
    void this.send(record);
  }

  /**
   * Reports a workflow execution to the Usage API.
   *
   * Callers should NOT await this -- it is designed to be fire-and-forget.
   * All errors are caught and logged internally. Returning a Promise enables
   * tests to await completion without needing fake timers.
   */
  public async reportWorkflowExecution(
    execution: EsWorkflowExecution,
    cloudSetup?: WorkflowMeteringCloud
  ): Promise<void> {
    const record = buildWorkflowMeteringRecord(execution, cloudSetup);
    if (record) {
      await this.send(record);
    }
  }

  private async send(record: WorkflowMeteringRecord): Promise<void> {
    try {
      await this.usageReportingService.reportUsage([record]);
    } catch (err) {
      // Log with billing-relevant details per monitoring requirements:
      // project ID, type, and count for impact assessment
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Failed to report workflow metering for record ${record.id} ` +
          `(instanceGroupId=${record.source.instance_group_id}, type=${WORKFLOWS_USAGE_TYPE}, quantity=1): ${errorMessage}`
      );
    }
  }
}
