/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { ElasticsearchClient, Logger } from '@kbn/core/server';
import type { DataStreamsSetup } from '@kbn/core-data-streams-server';
import { DataStreamClient } from '@kbn/data-streams';
import type { DataStreamDefinition } from '@kbn/data-streams';
import type { MappingsDefinition } from '@kbn/es-mappings';
import type { ExecutionStorageSource } from './repositories/data_access_layer';
import {
  STEP_EXECUTIONS_DATA_STREAM_DEFINITION,
  WORKFLOW_EXECUTIONS_DATA_STREAM_DEFINITION,
} from './repositories/data_access_layer/implementations/data_stream/data_stream_definitions';
import { WORKFLOWS_LOGS_DATA_STREAM_DEFINITION } from './repositories/logs_repository/data_stream';
import { WORKFLOWS_EVENTS_DATA_STREAM_DEFINITION } from './trigger_events/event_logs';

/** The storage settings that decide which data streams the engine owns. */
export interface WorkflowDataStreamsStorage {
  source: ExecutionStorageSource;
  /** Retention of the execution data streams (`data_stream` source only). */
  dataRetention: string;
}

/**
 * The data stream definitions of the engine, by data stream name: the execution logs, the trigger
 * events and, when executions are stored in data streams, the workflow and step executions.
 *
 * This is the one place the definitions are listed. Kibana registers them with Core
 * ({@link registerWorkflowDataStreams}); a task process builds clients straight from them with
 * `DataStreamClient.fromDefinition({ dataStream, elasticsearchClient })`, installing nothing.
 */
export const getWorkflowDataStreamDefinitions = (
  storage: WorkflowDataStreamsStorage
): Record<string, DataStreamDefinition<MappingsDefinition>> => {
  const definitions: Array<DataStreamDefinition<MappingsDefinition>> = [
    WORKFLOWS_LOGS_DATA_STREAM_DEFINITION,
    WORKFLOWS_EVENTS_DATA_STREAM_DEFINITION,
  ];
  if (storage.source === 'data_stream') {
    for (const definition of [
      WORKFLOW_EXECUTIONS_DATA_STREAM_DEFINITION,
      STEP_EXECUTIONS_DATA_STREAM_DEFINITION,
    ]) {
      definitions.push({
        name: definition.name,
        version: definition.version,
        hidden: definition.hidden,
        template: {
          mappings: definition.mappings,
          settings: definition.settings,
          lifecycle: { data_retention: storage.dataRetention },
        },
      });
    }
  }
  return Object.fromEntries(definitions.map((definition) => [definition.name, definition]));
};

/** Registers the data streams of the engine with Core (Kibana's setup only). */
export const registerWorkflowDataStreams = (
  core: { dataStreams: Pick<DataStreamsSetup, 'registerDataStream'> },
  storage: WorkflowDataStreamsStorage
): void => {
  for (const definition of Object.values(getWorkflowDataStreamDefinitions(storage))) {
    core.dataStreams.registerDataStream(definition);
  }
};

/**
 * Installs the templates of the data streams of the engine, as Kibana does at startup. For tests
 * that need what Kibana installs before a task process runs against Elasticsearch.
 */
export const installWorkflowDataStreamTemplates = async ({
  esClient,
  logger,
  storage,
}: {
  esClient: ElasticsearchClient;
  logger: Logger;
  storage: WorkflowDataStreamsStorage;
}): Promise<void> => {
  for (const dataStream of Object.values(getWorkflowDataStreamDefinitions(storage))) {
    await DataStreamClient.initializeTemplate({
      dataStream,
      elasticsearchClient: esClient,
      logger,
    });
  }
};
