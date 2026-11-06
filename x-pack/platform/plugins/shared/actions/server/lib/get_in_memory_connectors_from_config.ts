/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Logger } from '@kbn/core/server';
import type { ActionsConfig } from '../config';
import type { ConnectorWithOptionalDeprecation } from '../application/connector/lib';
import { isConnectorDeprecated } from '../application/connector/lib';
import { getAlertHistoryEsIndex } from '../preconfigured_connectors/alert_history_es_index/alert_history_es_index';
import { AlertHistoryEsIndexConnectorId } from '../../common';
import type { InMemoryConnector } from '../types';

/** The connectors that kibana.yml defines: the preconfigured ones and the alert history index. */
export const getInMemoryConnectorsFromConfig = (
  actionsConfig: ActionsConfig,
  logger: Logger
): InMemoryConnector[] => {
  const inMemoryConnectors: InMemoryConnector[] = [];
  if (actionsConfig.preconfiguredAlertHistoryEsIndex) {
    inMemoryConnectors.push(getAlertHistoryEsIndex());
  }

  for (const preconfiguredId of Object.keys(actionsConfig.preconfigured)) {
    if (preconfiguredId !== AlertHistoryEsIndexConnectorId) {
      const rawPreconfiguredConnector: ConnectorWithOptionalDeprecation = {
        ...actionsConfig.preconfigured[preconfiguredId],
        id: preconfiguredId,
        isPreconfigured: true,
        isSystemAction: false,
        isConnectorTypeDeprecated: false,
      };

      inMemoryConnectors.push({
        ...rawPreconfiguredConnector,
        isDeprecated: isConnectorDeprecated(rawPreconfiguredConnector),
        isConnectorTypeDeprecated: false,
      });
    } else {
      logger.warn(
        `Preconfigured connectors cannot have the id "${AlertHistoryEsIndexConnectorId}" because this is a reserved id.`
      );
    }
  }

  return inMemoryConnectors;
};
