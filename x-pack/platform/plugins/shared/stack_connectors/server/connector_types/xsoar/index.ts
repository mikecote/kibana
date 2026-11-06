/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { SubActionConnectorType } from '@kbn/actions-plugin/server/sub_action_framework/types';
import { ValidatorType } from '@kbn/actions-plugin/server/sub_action_framework/types';
import {
  SecurityConnectorFeatureId,
  WorkflowsConnectorFeatureId,
  AgentBuilderConnectorFeatureId,
} from '@kbn/actions-plugin/common';
import { urlAllowListValidator } from '@kbn/actions-plugin/server';
import type { Config, Secrets } from '@kbn/connector-schemas/xsoar';
import {
  CONNECTOR_ID,
  CONNECTOR_NAME,
  ConfigSchema,
  SecretsSchema,
} from '@kbn/connector-schemas/xsoar';

import { renderParameterTemplates } from './render';

export type XSOARConnectorType = SubActionConnectorType<Config, Secrets>;

export function getConnectorType(): XSOARConnectorType {
  return {
    id: CONNECTOR_ID,
    minimumLicenseRequired: 'platinum',
    name: CONNECTOR_NAME,
    getService: async (params) => {
      const { XSOARConnector } = await import('./xsoar');
      return new XSOARConnector(params);
    },
    supportedFeatureIds: [
      SecurityConnectorFeatureId,
      WorkflowsConnectorFeatureId,
      AgentBuilderConnectorFeatureId,
    ],
    schema: {
      config: ConfigSchema,
      secrets: SecretsSchema,
    },
    renderParameterTemplates,
    validators: [{ type: ValidatorType.CONFIG, validator: urlAllowListValidator('url') }],
  };
}
