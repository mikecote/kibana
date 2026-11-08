/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { EmbeddableSetup } from '@kbn/embeddable-plugin/server';
import type { EmbeddableContribution } from '@kbn/embeddable-plugin/server/task_process/embeddable_contribution';
import { URL_DRILLDOWN_SUPPORTED_TRIGGERS, URL_DRILLDOWN_TYPE } from '../common/constants';
import { urlDrilldownSchema } from './schemas';

/** Registers the plugin's native embeddable definitions in Main and workers. */
export const registerEmbeddableDefinitions = (embeddable: EmbeddableSetup): void => {
  embeddable.registerDrilldown(URL_DRILLDOWN_TYPE, {
    schema: urlDrilldownSchema,
    supportedTriggers: URL_DRILLDOWN_SUPPORTED_TRIGGERS,
  });
};

export const contribution: EmbeddableContribution = { register: registerEmbeddableDefinitions };
