/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { identity } from 'lodash';
import type { PersistableState } from '@kbn/kibana-utils-plugin/common';
import type { EmbeddableRegistrationIds } from './task_process/embeddable_contribution';
import type { EmbeddableSetup, EmbeddableStart } from './plugin';
import type { EmbeddableFactoryRegistry } from './types';
import type { EmbeddableStateWithType } from './persistable_state/types';
import {
  getExtractFunction,
  getInjectFunction,
  getMigrateFunction,
  getTelemetryFunction,
} from './persistable_state';
import { getAllMigrations } from './persistable_state/get_all_migrations';
import { getDrilldownRegistry } from './drilldowns/registry';
import { getEmbeddableServerRegistry } from './embeddable_transforms/registry';

/** Creates the native embeddable registries and persistence SDK used by Main and task workers. */
export const createEmbeddableServices = (): {
  setup: EmbeddableSetup;
  start: EmbeddableStart;
  resetSchemaCache: () => void;
  getRegistrationIds: () => EmbeddableRegistrationIds;
} => {
  const definitionIds = new Set<string>();
  const drilldownIds = new Set<string>();
  const factories: EmbeddableFactoryRegistry = new Map();
  const drilldowns = getDrilldownRegistry();
  const transforms = getEmbeddableServerRegistry(drilldowns);
  const registerDrilldown = drilldowns.registerDrilldown as EmbeddableSetup['registerDrilldown'];
  const getFactory = (id: string): PersistableState<EmbeddableStateWithType> =>
    factories.get(id) ?? {
      telemetry: (state, stats) => stats,
      inject: (state) => state,
      extract: (state) => ({ state, references: [] }),
      migrations: {},
    };
  const migrate = getMigrateFunction(getFactory);
  const persistence = {
    telemetry: getTelemetryFunction(getFactory),
    extract: getExtractFunction(getFactory),
    inject: getInjectFunction(getFactory),
    getAllMigrations: () => getAllMigrations([...factories.values()], migrate),
  };
  return {
    setup: {
      ...persistence,
      registerEmbeddableFactory: (factory) => {
        if (factories.has(factory.id))
          throw new Error(
            `Embeddable factory [embeddableFactoryId = ${factory.id}] already registered in Embeddables API.`
          );
        factories.set(factory.id, {
          id: factory.id,
          telemetry: factory.telemetry || ((state, stats) => stats),
          inject: factory.inject || identity,
          extract:
            factory.extract || ((state: EmbeddableStateWithType) => ({ state, references: [] })),
          migrations: factory.migrations || {},
        });
      },
      registerDrilldown: (type, drilldown) => {
        registerDrilldown(type, drilldown);
        drilldownIds.add(type);
      },
      registerEmbeddableServerDefinition: (type, definition) => {
        transforms.registerEmbeddableServerDefinition(type, definition);
        definitionIds.add(type);
      },
    },
    start: {
      ...persistence,
      getAllEmbeddableSchemas: transforms.getAllEmbeddableSchemas,
      getTransforms: transforms.getEmbeddableTransforms,
    },
    resetSchemaCache: transforms.resetCache,
    getRegistrationIds: () => ({
      factories: [...factories.keys()].sort(),
      definitions: [...definitionIds].sort(),
      drilldowns: [...drilldownIds].sort(),
      migrations: Object.fromEntries(
        [...factories].map(([id, factory]) => [
          id,
          Object.keys(
            typeof factory.migrations === 'function' ? factory.migrations() : factory.migrations
          ).sort(),
        ])
      ),
    }),
  };
};
