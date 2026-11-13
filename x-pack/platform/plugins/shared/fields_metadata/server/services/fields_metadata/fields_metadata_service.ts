/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { EcsFlat as ecsFields } from '@elastic/ecs';
import { semconvFlat as otelFields } from '@kbn/otel-semantic-conventions';
import type { CoreStart, KibanaRequest, Logger } from '@kbn/core/server';
import { FieldsMetadataClient } from './fields_metadata_client';
import type { FieldsMetadataCapabilities } from './fields_metadata_client';
import type { FieldsMetadataTaskProcessSettings } from '../../task_process_settings';
import { EcsFieldsRepository } from './repositories/ecs_fields_repository';
import { IntegrationFieldsRepository } from './repositories/integration_fields_repository';
import { MetadataFieldsRepository } from './repositories/metadata_fields_repository';
import { OtelFieldsRepository } from './repositories/otel_fields_repository';
import type {
  IntegrationFieldsExtractor,
  IntegrationListExtractor,
  StreamsFieldsExtractor,
} from './repositories/types';
import type { FieldsMetadataServiceSetup, FieldsMetadataServiceStart } from './types';
import { MetadataFields as metadataFields } from '../../../common/metadata_fields';
import { StreamsFieldsRepository } from './repositories/streams_fields_repository';

export interface FieldsMetadataExecutionServices {
  elasticsearch: { client: Pick<CoreStart['elasticsearch']['client'], 'asScoped'> };
  getCapabilities: (request: KibanaRequest) => Promise<FieldsMetadataCapabilities>;
}

export class FieldsMetadataService {
  private readonly extractorIds: FieldsMetadataTaskProcessSettings = {};
  private integrationFieldsExtractor: IntegrationFieldsExtractor = () => Promise.resolve({});
  private integrationListExtractor: IntegrationListExtractor = () => Promise.resolve([]);
  private streamsFieldsExtractor: StreamsFieldsExtractor = () => Promise.resolve({});

  constructor(private readonly logger: Logger) {}

  public setup(): FieldsMetadataServiceSetup {
    return {
      registerIntegrationFieldsExtractor: (extractor: IntegrationFieldsExtractor, id: string) => {
        this.integrationFieldsExtractor = extractor;
        this.extractorIds.integrationFieldsExtractor = id;
      },
      registerIntegrationListExtractor: (extractor: IntegrationListExtractor, id: string) => {
        this.integrationListExtractor = extractor;
        this.extractorIds.integrationListExtractor = id;
      },
      registerStreamsFieldsExtractor: (extractor: StreamsFieldsExtractor, id: string) => {
        this.streamsFieldsExtractor = extractor;
        this.extractorIds.streamsFieldsExtractor = id;
      },
    };
  }

  /** Snapshots the active provider of each extractor registry entry. */
  public getTaskProcessSettings(): FieldsMetadataTaskProcessSettings {
    return { ...this.extractorIds };
  }

  public start(core: CoreStart): FieldsMetadataServiceStart {
    return this.startFromServices({
      elasticsearch: core.elasticsearch,
      getCapabilities: async (request) => {
        const { fleet, fleetv2 } = await core.capabilities.resolveCapabilities(request, {
          capabilityPath: '*',
        });
        return { fleet, fleetv2 };
      },
    });
  }

  public startFromServices({
    elasticsearch,
    getCapabilities,
  }: FieldsMetadataExecutionServices): FieldsMetadataServiceStart {
    const { logger, integrationFieldsExtractor, integrationListExtractor, streamsFieldsExtractor } =
      this;

    const ecsFieldsRepository = EcsFieldsRepository.create({ ecsFields });
    const metadataFieldsRepository = MetadataFieldsRepository.create({ metadataFields });
    const integrationFieldsRepository = IntegrationFieldsRepository.create({
      integrationFieldsExtractor,
      integrationListExtractor,
    });
    const otelFieldsRepository = OtelFieldsRepository.create({ otelFields });

    return {
      getClient: async (request) => {
        const { fleet, fleetv2 } = await getCapabilities(request);

        const esClient = elasticsearch.client.asScoped(request).asCurrentUser;
        const streamsFieldsRepository = StreamsFieldsRepository.create({
          streamsFieldsExtractor: (params) => streamsFieldsExtractor({ ...params, esClient }),
        });

        return FieldsMetadataClient.create({
          capabilities: { fleet, fleetv2 },
          logger,
          ecsFieldsRepository,
          metadataFieldsRepository,
          integrationFieldsRepository,
          otelFieldsRepository,
          streamsFieldsRepository,
        });
      },
    };
  }
}
