/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { CoreSetup, CoreStart, Plugin, RequestHandlerContext } from '@kbn/core/server';
import type { WorkflowsExtensionsServerPluginSetup } from '@kbn/workflows-extensions/server';
import { distinctUntilChanged, skip } from 'rxjs';

import type {
  PersistableStateService,
  MigrateFunctionsObject,
} from '@kbn/kibana-utils-plugin/common';
import type { ZodObjectType } from '@kbn/zod';
import { EMBEDDABLE_RUNTIME_SETTINGS_ID } from './task_process/embeddable_contribution';
import type { EmbeddableRegistryDefinition } from './types';
import type { EmbeddableStateWithType } from './persistable_state/types';
import type { EmbeddableTransforms } from '../common';
import type { DrilldownSetup, DrilldownState } from './drilldowns/types';
import type { EmbeddableServerDefinition } from './embeddable_transforms/types';
import { createEmbeddableServices } from './create_embeddable_services';
import { registerSearchRoute } from './search_route';

export interface EmbeddableSetup extends PersistableStateService<EmbeddableStateWithType> {
  registerEmbeddableFactory: (factory: EmbeddableRegistryDefinition) => void;
  /*
   * Use registerDrilldown to register transforms and schema for a drilldown type.
   */
  registerDrilldown: <
    StoredState extends DrilldownState = DrilldownState,
    State extends DrilldownState = DrilldownState
  >(
    type: string,
    drilldown: DrilldownSetup<StoredState, State>
  ) => void;
  /**
   * Registers an embeddable server defintion.
   * Be sure to register an embeddable public definition for this type.
   */
  registerEmbeddableServerDefinition: (
    type: string,
    transforms: EmbeddableServerDefinition<any, any>
  ) => void;
  getAllMigrations: () => MigrateFunctionsObject;
}

export type EmbeddableStart = PersistableStateService<EmbeddableStateWithType> & {
  /**
   * Returns all embeddable schemas registered with registerEmbeddableServerDefinition.
   */
  getAllEmbeddableSchemas: () => { [key: string]: { schema: ZodObjectType; title: string } };

  getTransforms: (type: string) =>
    | (EmbeddableTransforms & {
        schema?: ZodObjectType;
        throwOnUnmappedPanel?: EmbeddableServerDefinition['throwOnUnmappedPanel'];
      })
    | undefined;
};

export class EmbeddableServerPlugin implements Plugin<EmbeddableSetup, EmbeddableStart> {
  private readonly services = createEmbeddableServices();

  public setup(
    core: CoreSetup,
    plugins: { workflowsExtensions?: WorkflowsExtensionsServerPluginSetup } = {}
  ): EmbeddableSetup {
    plugins.workflowsExtensions?.registerTaskProcessSettings(
      EMBEDDABLE_RUNTIME_SETTINGS_ID,
      this.services.getRegistrationIds
    );
    const unversionedRouter = core.http.createRouter<RequestHandlerContext>();
    registerSearchRoute(unversionedRouter);
    return this.services.setup;
  }

  public start(core: CoreStart): EmbeddableStart {
    core.featureFlags
      .getBooleanValue$('lens.apiFormat', false)
      .pipe(skip(1), distinctUntilChanged())
      .subscribe(() => this.services.resetSchemaCache());
    return this.services.start;
  }

  public stop() {}
}
