/**
 * @jest-environment node
 */

/* eslint-disable @kbn/eslint/require-license-header */
/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import type { RuleProcessHarness } from '@kbn/alerting-plugin/server/task_types/testing/rule_process_harness';
import { startRuleProcessHarness } from '@kbn/alerting-plugin/server/task_types/testing/rule_process_harness';
import { SLO_BURN_RATE_RULE_TYPE_ID } from '@kbn/rule-data-utils';
import { ALERT_ACTION_ID, SLI_DESTINATION_INDEX_NAME } from '../../common/constants';
import { DefaultSLODefinitionRepository } from '../services/slo_definition_repository';
import { createSLO } from '../services/fixtures/slo';
import { taskType } from '../task_types/slo_burn_rate.task';

const ALERTS_INDEX = '.alerts-observability.slo.alerts-*';

/**
 * The SLO burn rate rule type from its own bundle, forked the way Kibana does, against a real
 * Elasticsearch with SLO definitions (saved objects, as the SLO plugin stores them) and the SLI
 * documents of one of them. Each run is compared with the same rule run in the test process, as
 * Kibana's runtime does.
 */
describe('the SLO burn rate rule type served from a bundle', () => {
  let harness: RuleProcessHarness;
  const failing = createSLO({ id: 'slo-failing', name: 'Failing SLO' });
  const quiet = createSLO({ id: 'slo-quiet', name: 'Quiet SLO' });
  const disabled = createSLO({ id: 'slo-disabled', name: 'Disabled SLO', enabled: false });

  const ruleFor = (id: string, sloId: string) => ({
    id,
    ruleTypeId: SLO_BURN_RATE_RULE_TYPE_ID,
    consumer: 'slo',
    params: {
      sloId,
      windows: [
        {
          id: 'window-1',
          burnRateThreshold: 14.4,
          maxBurnRateThreshold: null,
          longWindow: { value: 1, unit: 'h' },
          shortWindow: { value: 30, unit: 'm' },
          actionGroup: ALERT_ACTION_ID,
        },
      ],
    },
  });

  beforeAll(async () => {
    harness = await startRuleProcessHarness({
      rules: [{ taskType, bundle: 'slo__slo_burn_rate' }],
      indices: {
        [SLI_DESTINATION_INDEX_NAME]: {
          properties: {
            '@timestamp': { type: 'date' },
            slo: {
              properties: {
                id: { type: 'keyword' },
                revision: { type: 'long' },
                instanceId: { type: 'keyword' },
                numerator: { type: 'long' },
                denominator: { type: 'long' },
                isGoodSlice: { type: 'byte' },
              },
            },
          },
        },
      },
    });
    const repository = new DefaultSLODefinitionRepository(
      harness.savedObjectsClient as never,
      loggingSystemMock.create().get()
    );
    for (const slo of [failing, quiet, disabled]) {
      await repository.create(slo);
    }
    // Every event of the failing SLO is bad: a burn rate of 100 against its 99% target. The windows
    // end before now (the sync delay of the SLO), so the document is a few minutes old.
    const now = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await harness.es.index({
      index: SLI_DESTINATION_INDEX_NAME,
      refresh: 'wait_for',
      document: {
        '@timestamp': now,
        slo: {
          id: failing.id,
          revision: failing.revision,
          instanceId: '*',
          numerator: 0,
          denominator: 100,
          groupings: {},
        },
      },
    });
  });

  afterAll(async () => {
    await harness?.stop();
  });

  it('alerts when the burn rate is over the threshold, as Kibana does', async () => {
    const { forked, inProcess } = await harness.runBoth(
      ruleFor('slo-burning', failing.id),
      ALERTS_INDEX
    );
    expect(forked.events.at(-1)).toEqual(
      expect.objectContaining({ action: 'execute', outcome: 'success' })
    );
    expect(forked.alerts).toHaveLength(1);
    expect(forked).toEqual(inProcess);
  });

  it('runs to a success without an alert when the SLO has no data, as Kibana does', async () => {
    const { forked, inProcess } = await harness.runBoth(
      ruleFor('slo-no-data', quiet.id),
      ALERTS_INDEX
    );
    expect(forked.alerts).toHaveLength(0);
    expect(forked.events.at(-1)).toEqual(
      expect.objectContaining({ action: 'execute', outcome: 'success' })
    );
    expect(forked).toEqual(inProcess);
  });

  it('skips a disabled SLO, as Kibana does', async () => {
    const { forked, inProcess } = await harness.runBoth(
      ruleFor('slo-skipped', disabled.id),
      ALERTS_INDEX
    );
    expect(forked.alerts).toHaveLength(0);
    expect(forked.events.at(-1)).toEqual(
      expect.objectContaining({ action: 'execute', outcome: 'success' })
    );
    expect(forked).toEqual(inProcess);
  });

  it('fails the run of a rule whose SLO does not exist, with the same error as Kibana', async () => {
    const { forked, inProcess } = await harness.runBoth(
      ruleFor('slo-missing', 'does-not-exist'),
      ALERTS_INDEX
    );
    expect(forked.events.at(-1)).toEqual(
      expect.objectContaining({
        action: 'execute',
        outcome: 'failure',
        error: expect.stringContaining('is referencing an SLO which cannot be found'),
      })
    );
    // The error of the run is serialized over the wire; what the rule reports is the same.
    expect(forked.events).toEqual(inProcess.events);
    expect(forked.alerts).toEqual(inProcess.alerts);
  });
});
