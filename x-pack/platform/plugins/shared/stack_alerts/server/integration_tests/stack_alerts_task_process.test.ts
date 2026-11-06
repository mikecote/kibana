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

import type { RuleProcessHarness } from '@kbn/alerting-plugin/server/task_types/testing/rule_process_harness';
import { startRuleProcessHarness } from '@kbn/alerting-plugin/server/task_types/testing/rule_process_harness';
import { taskType as indexThreshold } from '../task_types/index_threshold.task';
import { taskType as geoContainment } from '../task_types/geo_containment.task';

const ALERTS_INDEX = '.alerts-stack.alerts-default';
const INDEX_THRESHOLD = '.index-threshold';
const GEO_CONTAINMENT = '.geo-containment';
const CONNECTOR_ID = 'family-server-log';

/**
 * The index threshold and tracking containment rule types of stack alerts, each from its own bundle
 * forked the way Kibana does, against seeded data in a real Elasticsearch. Every run must be served by
 * the process (never declined to Kibana) and must write what a run in Kibana's own runtime writes.
 */
describe('the stack alerts rule types served from bundles', () => {
  let harness: RuleProcessHarness;

  const serverLog = {
    group: 'threshold met',
    actionTypeId: '.server-log',
    connectorId: CONNECTOR_ID,
    params: { level: 'info', message: 'matched {{context.title}}' },
  };

  const thresholdParams = (threshold: number) => ({
    index: ['threshold-source'],
    timeField: '@timestamp',
    aggType: 'count',
    groupBy: 'all',
    timeWindowSize: 1,
    timeWindowUnit: 'h',
    thresholdComparator: '>',
    threshold: [threshold],
  });

  beforeAll(async () => {
    harness = await startRuleProcessHarness({
      rules: [
        { taskType: indexThreshold, bundle: 'stackAlerts__index_threshold' },
        { taskType: geoContainment, bundle: 'stackAlerts__geo_containment' },
      ],
    });
    await harness.createConnector(CONNECTOR_ID);
    await harness.es.index({
      index: 'threshold-source',
      refresh: 'wait_for',
      document: { '@timestamp': new Date().toISOString(), message: 'hello' },
    });

    await harness.es.indices.create({
      index: 'geo-tracked',
      mappings: {
        properties: {
          '@timestamp': { type: 'date' },
          location: { type: 'geo_point' },
          entity: { type: 'keyword' },
        },
      },
    });
    await harness.es.indices.create({
      index: 'geo-boundaries',
      mappings: { properties: { shape: { type: 'geo_shape' }, name: { type: 'keyword' } } },
    });
    await harness.es.index({
      index: 'geo-boundaries',
      id: 'square',
      document: {
        name: 'the square',
        shape: {
          type: 'polygon',
          coordinates: [
            [
              [-10, -10],
              [-10, 10],
              [10, 10],
              [10, -10],
              [-10, -10],
            ],
          ],
        },
      },
    });
    await harness.es.index({
      index: 'geo-tracked',
      refresh: 'wait_for',
      document: {
        '@timestamp': new Date().toISOString(),
        location: { lat: 1, lon: 1 },
        entity: 'bike-1',
      },
    });
  });

  afterAll(async () => {
    await harness?.stop();
  });

  describe('index threshold', () => {
    it('alerts when the threshold is crossed, and enqueues its action, as Kibana does', async () => {
      const { forked, inProcess } = await harness.runBoth(
        {
          id: 'threshold-crossed',
          ruleTypeId: INDEX_THRESHOLD,
          params: thresholdParams(0),
          actions: [serverLog],
        },
        ALERTS_INDEX,
        4
      );
      expect(forked.alerts).toHaveLength(1);
      expect(forked.events.map((event: { action: string }) => event.action)).toEqual(
        expect.arrayContaining(['execute-start', 'active-instance', 'execute-action', 'execute'])
      );
      expect(forked.events.at(-1)).toEqual(expect.objectContaining({ outcome: 'success' }));
      expect(forked).toEqual(inProcess);

      const { actionTaskParams } = await harness.getEnqueued();
      expect(
        actionTaskParams.filter((params) =>
          String(params.executionId).startsWith('threshold-crossed-forked')
        )
      ).toHaveLength(1);
    });

    it('runs to a success without an alert when the threshold is not crossed, as Kibana does', async () => {
      const { forked, inProcess } = await harness.runBoth(
        {
          id: 'threshold-quiet',
          ruleTypeId: INDEX_THRESHOLD,
          params: thresholdParams(100),
        },
        ALERTS_INDEX
      );
      expect(forked.alerts).toHaveLength(0);
      expect(forked.events.at(-1)).toEqual(
        expect.objectContaining({ action: 'execute', outcome: 'success' })
      );
      expect(forked).toEqual(inProcess);
    });
  });

  describe('tracking containment', () => {
    const containmentRule = (id: string, extra: Record<string, unknown> = {}) => ({
      id,
      ruleTypeId: GEO_CONTAINMENT,
      params: {
        index: 'geo-tracked',
        indexRefName: 'tracked_index_geo-tracked-view',
        geoField: 'location',
        entity: 'entity',
        dateField: '@timestamp',
        boundaryType: 'entireIndex',
        boundaryIndexTitle: 'geo-boundaries',
        boundaryIndexRefName: 'boundary_index_geo-boundaries-view',
        boundaryGeoField: 'shape',
        boundaryNameField: 'name',
        ...extra,
      },
      references: [
        {
          id: 'geo-tracked-view',
          name: 'param:tracked_index_geo-tracked-view',
          type: 'index-pattern',
        },
        {
          id: 'geo-boundaries-view',
          name: 'param:boundary_index_geo-boundaries-view',
          type: 'index-pattern',
        },
      ],
    });

    it('reports the use of a licensed rule type from the process, to the store every node shares', async () => {
      // Tracking containment needs a gold license. Nothing has run in the test process yet, so what
      // is stored was written by the forked process.
      expect(await harness.getFeatureUsage()).toEqual([]);
      await harness.createRule(containmentRule('geo-usage'));
      await harness.run('geo-usage', GEO_CONTAINMENT);

      expect(JSON.stringify(await harness.getFeatureUsage())).toContain('Tracking containment');
    });

    it('alerts for an entity inside a boundary, as Kibana does', async () => {
      const { forked, inProcess } = await harness.runBoth(
        containmentRule('geo-inside'),
        ALERTS_INDEX,
        3
      );
      expect(forked.alerts).toHaveLength(1);
      expect(forked.events.at(-1)).toEqual(expect.objectContaining({ outcome: 'success' }));
      expect(forked).toEqual(inProcess);
    });

    it('runs to a success without an alert when no entity is in a boundary, as Kibana does', async () => {
      const { forked, inProcess } = await harness.runBoth(
        containmentRule('geo-outside', {
          // Matches no entity, so nothing is contained.
          indexQuery: { query: 'entity: nobody', language: 'kuery' },
        }),
        ALERTS_INDEX
      );
      expect(forked.alerts).toHaveLength(0);
      expect(forked.events.at(-1)).toEqual(
        expect.objectContaining({ action: 'execute', outcome: 'success' })
      );
      expect(forked).toEqual(inProcess);
    });
  });
});
