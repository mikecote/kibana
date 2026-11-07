/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { PluginInitializerContext } from '@kbn/core/server';

export type { FieldsMetadataServerSetup, FieldsMetadataServerStart } from './types';
export { FIELDS_METADATA_TASK_PROCESS_SETTINGS_ID } from './task_process_settings';
export type { FieldsMetadataTaskProcessSettings } from './task_process_settings';
export type {
  IntegrationName,
  DatasetName,
  ExtractedIntegrationFields,
  ExtractedDatasetFields,
  IFieldsMetadataClient,
  FieldsMetadataExtractors,
  StreamsFieldsExtractor,
  IntegrationFieldsExtractor,
  IntegrationListExtractor,
} from './services/fields_metadata/types';

export async function plugin(context: PluginInitializerContext) {
  const { FieldsMetadataPlugin } = await import('./plugin');
  return new FieldsMetadataPlugin(context);
}
