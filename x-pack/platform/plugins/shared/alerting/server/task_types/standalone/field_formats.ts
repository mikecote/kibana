/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { DateFormat, DateNanosFormat } from '@kbn/field-formats-plugin/server/lib/converters';
import { baseFormatters } from '@kbn/field-formats-plugin/common';
import { createFieldFormatServiceFactory } from '@kbn/field-formats-plugin/server/field_format_service_factory';

/**
 * The part of the field formats start contract that rule types use, for a task process: the same
 * registry the plugin builds, from the same formats.
 */
export const createStandaloneFieldFormats = () => ({
  fieldFormatServiceFactory: createFieldFormatServiceFactory([
    DateFormat,
    DateNanosFormat,
    ...baseFormatters,
  ]),
});
