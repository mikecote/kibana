/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { Logger } from '@kbn/core/server';
import type { EsWorkflowExecution } from '@kbn/workflows';
import {
  buildWorkflowMeteringRecord,
  createWorkflowsMeteringReporter,
} from './build_metering_record';
import { METERING_SOURCE_ID, WORKFLOWS_USAGE_TYPE } from './constants';
import { WorkflowsMeteringService } from './metering_service';

const execution = (overrides: Partial<EsWorkflowExecution> = {}): EsWorkflowExecution =>
  ({
    id: 'exec-1',
    workflowId: 'wf-1',
    spaceId: 'default',
    status: 'completed',
    triggeredBy: 'manual',
    isTestRun: false,
    duration: 90_000,
    finishedAt: '2024-01-01T00:01:30.000Z',
    workflowDefinition: { steps: [{ type: 'slack' }, { type: 'slack' }, { type: 'foreach' }] },
    ...overrides,
  } as unknown as EsWorkflowExecution);

const serverless = { serverless: { projectId: 'project-1' } } as never;
const stateful = {
  deploymentId: 'deployment-1',
  csp: 'aws',
  region: 'us-east-1',
  elasticsearchClusterId: 'cluster-1',
} as never;

describe('buildWorkflowMeteringRecord', () => {
  it('builds a serverless record', () => {
    const record = buildWorkflowMeteringRecord(execution(), serverless);
    expect(record).toEqual({
      id: 'workflow-execution-exec-1',
      usage_timestamp: '2024-01-01T00:01:30.000Z',
      creation_timestamp: expect.any(String),
      usage: {
        type: WORKFLOWS_USAGE_TYPE,
        quantity: 1,
        period_seconds: 90,
        metadata: expect.objectContaining({
          duration_ms: '90000',
          duration_minutes: '2',
          status: 'completed',
          workflow_id: 'wf-1',
          space_id: 'default',
          step_count: '3',
          step_types: JSON.stringify({ slack: 2, foreach: 1 }),
        }),
      },
      source: {
        id: METERING_SOURCE_ID,
        instance_group_id: 'project-1',
        instance_group_type: 'serverless_project',
      },
    });
  });

  it('builds a stateful record with the deployment and cluster', () => {
    expect(buildWorkflowMeteringRecord(execution(), stateful)?.source).toEqual({
      id: METERING_SOURCE_ID,
      instance_group_id: 'deployment-1',
      instance_group_type: 'stateful_deployment',
      provider: 'aws',
      region: 'us-east-1',
      metadata: { cluster_id: 'cluster-1' },
    });
  });

  it('builds a plain serializable object', () => {
    const record = buildWorkflowMeteringRecord(execution(), serverless);
    expect(JSON.parse(JSON.stringify(record))).toEqual(record);
  });

  it.each([
    ['self-managed (no project or deployment)', execution(), {} as never],
    ['a non-terminal execution', execution({ status: 'running' as never }), serverless],
    ['a skipped execution', execution({ status: 'skipped' as never }), serverless],
  ])('builds nothing for %s', (_name, exec, cloud) => {
    expect(buildWorkflowMeteringRecord(exec, cloud)).toBeUndefined();
  });
});

describe('createWorkflowsMeteringReporter', () => {
  it('hands the record of a finished execution to the sink', async () => {
    const sink = { report: jest.fn() };
    await createWorkflowsMeteringReporter(sink).reportWorkflowExecution(execution(), serverless);
    expect(sink.report).toHaveBeenCalledTimes(1);
    expect(sink.report).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'workflow-execution-exec-1' })
    );
  });

  it('does not call the sink when there is nothing to meter', async () => {
    const sink = { report: jest.fn() };
    await createWorkflowsMeteringReporter(sink).reportWorkflowExecution(execution(), {} as never);
    expect(sink.report).not.toHaveBeenCalled();
  });
});

describe('WorkflowsMeteringService as a sink', () => {
  const logger = { error: jest.fn() } as unknown as Logger;

  it('sends a record to the usage API without waiting for it', async () => {
    const usage = { reportUsage: jest.fn().mockResolvedValue(undefined) };
    const service = new WorkflowsMeteringService(usage as never, logger);
    const record = buildWorkflowMeteringRecord(execution(), serverless)!;
    expect(service.report(record)).toBeUndefined();
    await Promise.resolve();
    expect(usage.reportUsage).toHaveBeenCalledWith([record]);
  });

  it('flushes what it reported: a task process waits for the records before it answers', async () => {
    let finish!: () => void;
    const usage = {
      reportUsage: jest.fn(() => new Promise<void>((resolve) => (finish = resolve))),
    };
    const service = new WorkflowsMeteringService(usage as never, logger);
    service.report(buildWorkflowMeteringRecord(execution(), serverless)!);
    let flushed = false;
    const flushing = service.flush().then(() => (flushed = true));
    await new Promise((resolve) => setImmediate(resolve));
    expect(flushed).toBe(false);
    finish();
    await flushing;
    expect(flushed).toBe(true);
  });

  it('flushes after a failure too, having logged it as Kibana does', async () => {
    const usage = { reportUsage: jest.fn().mockRejectedValue(new Error('down')) };
    const service = new WorkflowsMeteringService(usage as never, logger);
    service.report(buildWorkflowMeteringRecord(execution(), serverless)!);
    await expect(service.flush()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
  });

  it('logs instead of throwing when the usage API fails', async () => {
    const usage = { reportUsage: jest.fn().mockRejectedValue(new Error('down')) };
    const service = new WorkflowsMeteringService(usage as never, logger);
    const record = buildWorkflowMeteringRecord(execution(), serverless)!;
    expect(() => service.report(record)).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('workflow-execution-exec-1'));
  });
});
