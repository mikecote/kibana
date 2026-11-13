/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { WorkflowStepsContribution } from '@kbn/workflows-extensions/server';
import { createStreamsFieldsMetadataExtractor } from '../register_fields_metadata_extractors';

export const contribution: WorkflowStepsContribution = {
  provides: {
    'fieldsMetadata.extractors.streams': ({ logger }) => ({
      streamsFieldsExtractor: createStreamsFieldsMetadataExtractor({
        logger: logger.get('streams'),
      }),
    }),
  },
  register: () => {},
};
