/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { RuleRunActionsSetup } from '@kbn/actions-plugin/server/task_types/rule_run_actions';
import { parseExperimentalConfigValue } from '../../common/experimental_features';
import { registerConnectorTypes } from '../connector_types';

/**
 * Registers the connector types of this plugin where a task process enqueues the actions of a rule
 * run: which types exist and how their parameters render. Nothing here executes a connector, which
 * Kibana does when it runs the enqueued task. A rule module passes this as
 * `registerConnectorTypes`.
 */
export const registerConnectorTypesForRuleRuns = (
  actions: RuleRunActionsSetup,
  { publicBaseUrl }: { publicBaseUrl?: string } = {}
) =>
  registerConnectorTypes({
    // The part of the actions contract that registering a connector type uses.
    actions: actions as Parameters<typeof registerConnectorTypes>[0]['actions'],
    publicBaseUrl,
    experimentalFeatures: parseExperimentalConfigValue([]),
  });
