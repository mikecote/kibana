/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { CoreSetup, CoreStart, ElasticsearchClient, Logger } from '@kbn/core/server';
import type { EsWorkflowExecution, EsWorkflowStepExecution } from '@kbn/workflows';
import { DataStreamDataClient } from './data_stream_data_client';
import {
  STEP_EXECUTIONS_DATA_STREAM_DEFINITION,
  WORKFLOW_EXECUTIONS_DATA_STREAM_DEFINITION,
} from './data_stream_definitions';
import { DataStreamMetadataManager } from './data_stream_metadata_manager';
import { DocumentVersionManager } from './document_version_manager';
import { createRetryingEsClient } from '../../../../lib/create_retrying_es_client';
import type {
  CreateDataClientDeps,
  DataClientBundle,
  StepExecutionsDataClient,
  WorkflowExecutionsDataClient,
} from '../../types';

/**
 * The clients of the workflow and step execution data streams over an Elasticsearch client, with
 * nothing installed: Kibana registers and installs the data streams, so a task process builds its
 * clients with this over the streams that are already there. `init()` reads the mapping metadata the
 * clients version their documents with and must complete before a client is created; `stop()`
 * releases what it keeps.
 */
export const createDataStreamDataClients = ({
  esClient,
  logger,
}: {
  esClient: ElasticsearchClient;
  logger: Logger;
}): {
  init: () => Promise<void>;
  stop: () => void;
  createWorkflowDataClient: () => WorkflowExecutionsDataClient;
  createStepDataClient: () => StepExecutionsDataClient;
} => {
  const workflowMetadataManager = new DataStreamMetadataManager({
    esClient,
    dataStreamName: WORKFLOW_EXECUTIONS_DATA_STREAM_DEFINITION.name,
    logger,
  });
  const stepMetadataManager = new DataStreamMetadataManager({
    esClient,
    dataStreamName: STEP_EXECUTIONS_DATA_STREAM_DEFINITION.name,
    logger,
  });
  return {
    init: async () => {
      await Promise.all([workflowMetadataManager.init(), stepMetadataManager.init()]);
    },
    stop: () => {
      workflowMetadataManager.dispose();
      stepMetadataManager.dispose();
    },
    createWorkflowDataClient: () =>
      new DataStreamDataClient<EsWorkflowExecution>({
        esClient,
        dataStreamName: WORKFLOW_EXECUTIONS_DATA_STREAM_DEFINITION.name,
        versionManager: new DocumentVersionManager({
          esClient,
          dataStreamName: WORKFLOW_EXECUTIONS_DATA_STREAM_DEFINITION.name,
          metadataManager: workflowMetadataManager,
          additionalIndexesToQuery: ['.workflows-executions'],
        }),
        metadataManager: workflowMetadataManager,
        additionalIndexesToQuery: ['.workflows-executions'],
        logger,
        dateField: 'createdAt',
      }),
    createStepDataClient: () =>
      new DataStreamDataClient<EsWorkflowStepExecution>({
        esClient,
        dataStreamName: STEP_EXECUTIONS_DATA_STREAM_DEFINITION.name,
        versionManager: new DocumentVersionManager({
          esClient,
          dataStreamName: STEP_EXECUTIONS_DATA_STREAM_DEFINITION.name,
          metadataManager: stepMetadataManager,
          additionalIndexesToQuery: ['.workflows-step-executions'],
        }),
        metadataManager: stepMetadataManager,
        additionalIndexesToQuery: ['.workflows-step-executions'],
        logger,
        dateField: 'startedAt',
      }),
  };
};

/** Initializes the execution streams through native Core before opening their shared data clients. */
export const initializeDataStreamDataClients = async ({
  esClient,
  logger,
  dataStreams,
}: {
  esClient: ElasticsearchClient;
  logger: Logger;
  dataStreams: Pick<CoreStart['dataStreams'], 'initializeClient'>;
}): Promise<ReturnType<typeof createDataStreamDataClients>> => {
  await Promise.all([
    dataStreams.initializeClient(WORKFLOW_EXECUTIONS_DATA_STREAM_DEFINITION.name),
    dataStreams.initializeClient(STEP_EXECUTIONS_DATA_STREAM_DEFINITION.name),
  ]);
  const clients = createDataStreamDataClients({ esClient, logger });
  await clients.init();
  return clients;
};

export class DataStreamDataClientBundle implements DataClientBundle {
  private clients: ReturnType<typeof createDataStreamDataClients> | undefined;

  constructor(private readonly deps: CreateDataClientDeps) {}

  /**
   * The execution data streams are registered with Core by `registerWorkflowDataStreams`, the one
   * place the engine's data stream definitions are listed.
   */
  async initSetup(_coreSetup: CoreSetup): Promise<void> {}

  async initStart(coreStart: CoreStart): Promise<void> {
    this.clients = await initializeDataStreamDataClients({
      dataStreams: coreStart.dataStreams,
      esClient: createRetryingEsClient(
        coreStart.elasticsearch.client.asInternalUser,
        this.deps.logger
      ),
      logger: this.deps.logger,
    });
  }

  async stop(): Promise<void> {
    this.clients?.stop();
  }

  createWorkflowDataClient(): WorkflowExecutionsDataClient {
    if (!this.clients) {
      throw new Error(
        'DataStreamDataClientBundle.initStart() must complete before creating clients'
      );
    }
    return this.clients.createWorkflowDataClient();
  }

  createStepDataClient(): StepExecutionsDataClient {
    if (!this.clients) {
      throw new Error(
        'DataStreamDataClientBundle.initStart() must complete before creating clients'
      );
    }
    return this.clients.createStepDataClient();
  }
}
