/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import {
  createNativeVisualizationMigrations,
  getLensRuntimeSettings,
} from './visualization_migration_contribution';

const migration = (state: { column: string }) => ({ accessor: state.column });
const migrations = { rotatingNumber: () => ({ '8.1.0': migration }) };

it('runs contributed migrations only when Main has registered them', () => {
  const expected = getLensRuntimeSettings(migrations);
  const native = createNativeVisualizationMigrations([{ migrations }], expected);
  expect(native.rotatingNumber()['8.1.0']({ column: 'native-column' })).toEqual({
    accessor: 'native-column',
  });
  expect(
    createNativeVisualizationMigrations([{ migrations }], { visualizationMigrations: {} })
  ).toEqual({});
  expect(expected).toEqual({ visualizationMigrations: { rotatingNumber: ['8.1.0'] } });
});

it('refuses missing, different or duplicate migration registrations', () => {
  const expected = getLensRuntimeSettings(migrations);
  expect(() => createNativeVisualizationMigrations([], expected)).toThrow('Missing native');
  expect(() =>
    createNativeVisualizationMigrations([{ migrations }], {
      visualizationMigrations: { rotatingNumber: ['8.2.0'] },
    })
  ).toThrow('differ');
  expect(() =>
    createNativeVisualizationMigrations([{ migrations }, { migrations }], expected)
  ).toThrow('registered already');
});

it('captures a new inventory for each dispatch', () => {
  const first = getLensRuntimeSettings(migrations);
  const current = getLensRuntimeSettings({
    ...migrations,
    newVisualization: () => ({ '9.0.0': migration }),
  });
  expect(first.visualizationMigrations.newVisualization).toBeUndefined();
  expect(current.visualizationMigrations.newVisualization).toEqual(['9.0.0']);
});
