/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { z } from '@kbn/zod';
import { loggerMock } from '@kbn/logging-mocks';
import { savedObjectsClientMock } from '@kbn/core/server/mocks';
import { createEmbeddableServices } from '@kbn/embeddable-plugin/server/create_embeddable_services';
import { createDashboardServerClient } from './create_dashboard_server_client';

const createClient = (label: string) => {
  const native = createEmbeddableServices();
  native.setup.registerEmbeddableServerDefinition('scoped-panel', {
    title: 'Scoped panel',
    getSchema: () => z.object({ value: z.literal(label) }),
    getTransforms: () => ({ transformOut: () => ({ value: label }) }),
  });
  return createDashboardServerClient({ embeddable: native.start, logger: loggerMock.create() });
};

const savedObject = {
  outcome: 'exactMatch' as const,
  saved_object: {
    type: 'dashboard',
    id: 'dashboard',
    references: [],
    attributes: {
      title: 'Scoped dashboard',
      panelsJSON: JSON.stringify([
        {
          type: 'scoped-panel',
          panelIndex: 'panel',
          gridData: { i: 'panel', x: 0, y: 0, w: 12, h: 8 },
          embeddableConfig: {},
        },
      ]),
    },
  },
};

it('keeps dashboard schemas and transformations isolated across overlapping reads', async () => {
  const first = createClient('first');
  const second = createClient('second');
  const delayed = Promise.withResolvers<typeof savedObject>();
  const firstObjects = savedObjectsClientMock.create();
  firstObjects.resolve.mockReturnValue(delayed.promise);
  const secondObjects = savedObjectsClientMock.create();
  secondObjects.resolve.mockResolvedValue(savedObject);
  const firstRead = first.read(firstObjects, 'dashboard');
  const secondResult = await second.read(secondObjects, 'dashboard');
  delayed.resolve(savedObject);
  const firstResult = await firstRead;
  expect(firstResult.data.panels).toEqual([
    expect.objectContaining({ config: { value: 'first' } }),
  ]);
  expect(secondResult.data.panels).toEqual([
    expect.objectContaining({ config: { value: 'second' } }),
  ]);
  firstObjects.resolve.mockResolvedValue(savedObject);
  expect((await first.read(firstObjects, 'dashboard')).data.panels).toEqual(
    firstResult.data.panels
  );
});
