/**
 * @jest-environment node
 */

/* eslint-disable @kbn/eslint/require-license-header, @typescript-eslint/no-non-null-assertion */
/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { loggerMock } from '@kbn/logging-mocks';
import {
  startWorkflowProcessHarness,
  WORKFLOW_PROCESS_TEST_MODES,
} from '@kbn/workflows-execution-engine/server/integration_tests/workflow_process_harness';
import { ALERT_EVENTS_DATA_STREAM } from '@kbn/alerting-v2-constants';
import { getDataStreamResourceDefinitions } from '../../../resources/datastreams/register';
import { configSchema } from '../../../config';
import { ALERTING_V2_TASK_PROCESS_SETTINGS_ID } from '../../../task_types/task_process_settings';
import { DatastreamInitializer } from '../../services/resource_service/datastream_initializer';

const WORKFLOW_ID = 'create-alert-workflow';

/**
 * Runs a `workflow:scheduled` workflow with the `alerting.create_alert` step from the real bundle in
 * a real task process: the step comes from the `workflow-steps` contribution of alerting_v2, checks
 * the write privilege of the run's user and writes the alert event to the data stream Kibana
 * installed. The run is served by the process (not declined).
 */
describe.each(WORKFLOW_PROCESS_TEST_MODES)(
  'alerting_v2 workflow steps in $mode (reuse: $reuse)',
  ({ mode, reuse }) => {
    let harness: Awaited<ReturnType<typeof startWorkflowProcessHarness>>;

    beforeAll(async () => {
      const config = configSchema.validate({});
      harness = await startWorkflowProcessHarness({
        mode,
        reuse,
        settings: {
          [ALERTING_V2_TASK_PROCESS_SETTINGS_ID]: {
            config,
            agentBuilderEnabled: false,
            smlEnabled: false,
          },
        },
        workflows: {
          [WORKFLOW_ID]: {
            steps: [
              {
                name: 'alert',
                type: 'alerting.create_alert',
                with: {
                  source: 'external_service',
                  fingerprint: 'monitor-1',
                  alert_status: 'active',
                  severity: 'high',
                  data: { rule_name: 'from a workflow' },
                },
              },
            ],
          },
        },
        // What Kibana installs at startup: the alert events data stream and its ingest pipeline.
        seed: async ({ es }) => {
          for (const definition of getDataStreamResourceDefinitions(config.retention)) {
            await new DatastreamInitializer(
              loggerMock.create(),
              es as never,
              definition
            ).initialize();
          }
        },
      });
    });

    afterAll(async () => {
      await harness?.stop();
    });

    it('writes the alert event Kibana would write, as the user of the run', async () => {
      const onDispatchFailure = jest.fn();
      await harness.run(WORKFLOW_ID, onDispatchFailure);

      // Not declined: the step type is in the registry of the process.
      expect(onDispatchFailure).not.toHaveBeenCalled();

      const [execution] = await harness.executionsOf(WORKFLOW_ID);
      expect(execution).toEqual(
        expect.objectContaining({ status: 'completed', spaceId: 'default' })
      );
      const steps = await harness.stepsOf(execution.id);
      expect(steps).toHaveLength(1);
      expect(steps[0]).toEqual(expect.objectContaining({ stepId: 'alert', status: 'completed' }));

      await harness.es.indices.refresh({ index: ALERT_EVENTS_DATA_STREAM });
      const { hits } = await harness.es.search<Record<string, any>>({
        index: ALERT_EVENTS_DATA_STREAM,
        query: { match_all: {} },
      });
      expect(hits.hits).toHaveLength(1);
      expect(hits.hits[0]._source).toEqual(
        expect.objectContaining({
          source: 'external_service',
          space_id: 'default',
          severity: 'high',
          status: 'breached',
          type: 'alert',
          data: { rule_name: 'from a workflow' },
          alert: expect.objectContaining({ status: 'active' }),
        })
      );
      expect(steps[0].output).toEqual(
        expect.objectContaining({ alert_id: expect.any(String), group_hash: expect.any(String) })
      );
    });
  }
);
