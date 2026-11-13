/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { z } from '@kbn/zod';
import { createEmbeddableServices } from './create_embeddable_services';
import { createNativeEmbeddables } from './task_process/create_native_embeddables';
import type { EmbeddableContribution } from './task_process/embeddable_contribution';

const contribution: EmbeddableContribution = {
  register: (setup) => {
    setup.registerEmbeddableFactory({
      id: 'native-panel',
      extract: (state) => ({
        state: { ...state, dataView: 'data-view-ref' },
        references: [{ type: 'index-pattern', id: 'logs-*', name: 'data-view-ref' }],
      }),
      inject: (state, references) => ({
        ...state,
        dataView: references.find(({ name }) => name === 'data-view-ref')?.id,
      }),
      migrations: { '9.0.0': (state) => ({ ...state, migrated: true }) },
    });
    setup.registerEmbeddableServerDefinition('native-panel', {
      title: 'Native panel',
      getSchema: () => z.object({ count: z.number().min(0) }),
      getTransforms: () => ({
        transformIn: (state) => ({ state, references: [] }),
        transformOut: (state) => state,
      }),
    });
    setup.registerDrilldown('native-drilldown', {
      schema: z.object({ url: z.string() }),
      supportedTriggers: ['click'],
    });
  },
};

describe('native embeddable services', () => {
  it('preserves persistence migrations, references and schema validation from Main', () => {
    const main = createEmbeddableServices();
    contribution.register(main.setup, {});
    const worker = createNativeEmbeddables([contribution], main.getRegistrationIds());
    const state = { type: 'native-panel' };
    const extracted = worker.start.extract(state);
    expect(extracted).toEqual(main.start.extract(state));
    expect(worker.start.inject(extracted.state, extracted.references)).toEqual(
      main.start.inject(extracted.state, extracted.references)
    );
    const migrate = worker.setup.getAllMigrations()['9.0.0'];
    expect(migrate(state)).toEqual(expect.objectContaining({ migrated: true }));
    expect(
      worker.start.getTransforms('native-panel')?.schema?.safeParse({ count: -1 }).success
    ).toBe(false);
    expect(
      worker.start.getTransforms('native-panel')?.schema?.safeParse({ count: 2 }).success
    ).toBe(true);
    expect(worker.getRegistrationIds()).toEqual(main.getRegistrationIds());
  });

  it('registers only what the dispatching Main enabled', () => {
    const worker = createNativeEmbeddables([contribution], {
      factories: [],
      definitions: [],
      drilldowns: [],
    });
    expect(worker.getRegistrationIds()).toEqual({
      factories: [],
      definitions: [],
      drilldowns: [],
      migrations: {},
    });
    expect(worker.start.getAllEmbeddableSchemas()).toEqual({});
  });

  it('fails explicitly for Main registrations without a native contribution', () => {
    expect(() =>
      createNativeEmbeddables([], { factories: ['missing'], definitions: [], drilldowns: [] })
    ).toThrow('Native embeddable factories are missing: missing');
  });

  it('refuses a factory whose custom migration inventory differs from Main', () => {
    expect(() =>
      createNativeEmbeddables([contribution], {
        factories: ['native-panel'],
        definitions: [],
        drilldowns: [],
        migrations: { 'native-panel': ['9.0.0', '9.1.0'] },
      })
    ).toThrow('Native embeddable migrations differ for native-panel');
  });

  it('isolates schemas and registrations across retained executions', () => {
    const first = createNativeEmbeddables([contribution], {
      factories: [],
      definitions: ['native-panel'],
      drilldowns: [],
    });
    first.start.getAllEmbeddableSchemas();
    const second = createNativeEmbeddables([contribution], {
      factories: [],
      definitions: [],
      drilldowns: [],
    });
    expect(second.start.getAllEmbeddableSchemas()).toEqual({});
    expect(first.start.getAllEmbeddableSchemas()).toHaveProperty('native-panel');
    expect(() => contribution.register(first.setup, {})).toThrow('already registered');
  });
});
