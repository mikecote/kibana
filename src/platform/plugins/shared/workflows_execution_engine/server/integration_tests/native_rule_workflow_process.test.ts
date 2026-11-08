/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { join } from 'path';
import type { ActionType } from '@kbn/actions-plugin/common';
import { createSystemConnectors } from '@kbn/actions-plugin/server/create_system_actions';
import { AlertStatusChangedTriggerId } from '@kbn/alerting-plugin/common/workflows/triggers';
import {
  RuleProcessHarness,
  TASK_MANAGER_INDEX,
} from '@kbn/alerting-plugin/server/task_types/testing/rule_process_harness';
import { ATTACK_DISCOVERY_SCHEDULES_ALERT_TYPE_ID } from '@kbn/elastic-assistant-common';
import { ConfigSchema as spacesConfigSchema } from '@kbn/spaces-plugin/server/config';
import { WORKFLOW_INDEX_NAME } from '@kbn/workflows/server/constants';
import { taskType } from './fixtures/native_rule_workflow_action_task';
import { config as engineConfig } from '../config';
import { installWorkflowDataStreamTemplates } from '../data_streams';
import {
  createOrUpdateIndex,
  WORKFLOWS_EXECUTIONS_INDEX,
  WORKFLOWS_EXECUTIONS_INDEX_MAPPINGS,
  WORKFLOWS_STEP_EXECUTIONS_INDEX,
  WORKFLOWS_STEP_EXECUTIONS_INDEX_MAPPINGS,
} from '../repositories/data_access_layer';
import { WORKFLOW_TASK_SCHEDULING_DEFINITIONS } from '../workflow_task_manager/task_scheduling_definitions';

const modes = [
  { mode: 'child_process', reuse: false },
  { mode: 'child_process', reuse: true },
  { mode: 'remote', reuse: false },
  { mode: 'remote', reuse: true },
] as const;
const connectorTypes = ['.workflows', '.test-native-workflow-run'].map(
  (id): ActionType => ({
    id,
    name: id,
    enabled: true,
    enabledInConfig: true,
    enabledInLicense: true,
    minimumLicenseRequired: 'gold',
    supportedFeatureIds: ['alerting', 'siem'],
    isSystemActionType: true,
    isDeprecated: false,
  })
);

describe.each(modes)('Native rule workflows in $mode/$reuse', ({ mode, reuse }) => {
  let harness: RuleProcessHarness;
  beforeAll(async () => {
    const config = engineConfig.schema.validate({});
    harness = new RuleProcessHarness();
    await harness.start({
      mode,
      reuse,
      rules: [
        {
          taskType,
          bundle: 'native_rule_workflow_action',
          file: join(__dirname, 'fixtures/native_rule_workflow_action_task.ts'),
        },
      ],
      registerTaskSchedulingDefinitions: (definitions) => {
        definitions.registerTaskDefinitions(WORKFLOW_TASK_SCHEDULING_DEFINITIONS);
      },
      additionalContributions: {
        'alerting-rule-run': [join(__dirname, 'fixtures/native_rule_workflow_opt_in.ts')],
      },
      settings: {
        workflowsExecutionEngine: config,
        workflowsExecutionEngineCloud: null,
        workflowsManagementRuntime: { available: true, managedWorkflowPluginIds: [] },
        inferenceFeatures: { features: [] },
        contextEngineManagedAiIndices: { registrations: [] },
        spacesRuntime: {
          config: spacesConfigSchema.validate({}, { offering: 'traditional' }),
          buildFlavor: 'traditional',
          features: [],
          cpsEnabled: false,
        },
      },
      inMemoryConnectors: createSystemConnectors(connectorTypes).map((connector) => ({
        ...connector,
      })),
    });
    const { es } = harness;
    const logger = harness.seeder.host.logger;
    await createOrUpdateIndex({
      esClient: es,
      indexName: WORKFLOWS_EXECUTIONS_INDEX,
      mappings: WORKFLOWS_EXECUTIONS_INDEX_MAPPINGS,
      logger,
    });
    await createOrUpdateIndex({
      esClient: es,
      indexName: WORKFLOWS_STEP_EXECUTIONS_INDEX,
      mappings: WORKFLOWS_STEP_EXECUTIONS_INDEX_MAPPINGS,
      logger,
    });
    await installWorkflowDataStreamTemplates({ esClient: es, logger, storage: config.storage });
    await es.indices.create({
      index: WORKFLOW_INDEX_NAME,
      mappings: {
        dynamic: false,
        properties: {
          spaceId: { type: 'keyword' },
          enabled: { type: 'boolean' },
          triggerTypes: { type: 'keyword' },
          managed: { type: 'boolean' },
          deleted_at: { type: 'date' },
          updated_at: { type: 'date' },
          created_at: { type: 'date' },
          yaml: { type: 'text', index: false },
          definition: { type: 'object', enabled: false },
        },
      },
    });
    const now = new Date().toISOString();
    for (const [id, trigger] of [
      ['connector-target', 'manual'],
      ['inline-target', 'manual'],
      ['status-target', AlertStatusChangedTriggerId],
    ]) {
      await es.index({
        index: WORKFLOW_INDEX_NAME,
        id,
        refresh: 'wait_for',
        document: {
          name: id,
          enabled: true,
          tags: [],
          triggerTypes: [trigger],
          yaml: `name: ${id}`,
          definition: {
            name: id,
            enabled: true,
            version: '1',
            triggers: [{ type: trigger }],
            steps: [{ name: 'log', type: 'console', with: { message: 'native rule workflow' } }],
          },
          createdBy: 'elastic',
          lastUpdatedBy: 'elastic',
          spaceId: 'default',
          valid: true,
          deleted_at: null,
          created_at: now,
          updated_at: now,
        },
      });
    }
  });
  afterAll(async () => harness?.stop());

  it('preserves scheduled and inline execution and delivers status events with fresh native services', async () => {
    for (const params of [
      { workflowId: 'connector-target', summaryMode: true, inline: false },
      { workflowId: 'connector-target', summaryMode: false, inline: false },
      { workflowId: 'inline-target', summaryMode: true, inline: true },
    ]) {
      const id = `native-workflow-${params.summaryMode}-${params.inline}`;
      await harness.createRule({
        id,
        ruleTypeId: ATTACK_DISCOVERY_SCHEDULES_ALERT_TYPE_ID,
        params,
      });
      const outcome = await harness.run(id, ATTACK_DISCOVERY_SCHEDULES_ALERT_TYPE_ID);
      expect(outcome.onDispatchFailure).not.toHaveBeenCalled();
      expect(outcome.result).toEqual(
        expect.objectContaining({
          state: expect.objectContaining({ alertTypeState: { status: 'ok' } }),
        })
      );
      expect(
        harness.logger.warn.mock.calls
          .map(([message]) => message)
          .filter((message) => String(message).includes('alert_status_changed_subscriber'))
      ).toEqual([]);
    }
    await harness.es.indices.refresh({ index: [WORKFLOWS_EXECUTIONS_INDEX, TASK_MANAGER_INDEX] });
    const executions = await harness.es.search<{ workflowId: string; status: string }>({
      index: WORKFLOWS_EXECUTIONS_INDEX,
      size: 20,
      query: { terms: { workflowId: ['connector-target', 'inline-target', 'status-target'] } },
    });
    expect(executions.hits.hits.map((hit) => hit._source?.workflowId).sort()).toEqual([
      'connector-target',
      'connector-target',
      'inline-target',
      'status-target',
      'status-target',
      'status-target',
    ]);
    expect(
      executions.hits.hits
        .filter((hit) => hit._source?.workflowId === 'inline-target')
        .map((hit) => hit._source?.status)
    ).toEqual(['completed']);
    const tasks = await harness.es.count({
      index: TASK_MANAGER_INDEX,
      query: { term: { 'task.taskType': 'workflow:run' } },
    });
    expect(tasks.count).toBe(5);
    expect(harness.getWorkerStats().spawned).toBe(reuse ? 1 : 3);
  });
});
