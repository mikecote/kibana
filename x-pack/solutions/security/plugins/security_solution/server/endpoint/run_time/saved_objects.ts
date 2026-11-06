/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { SavedObjectsType } from '@kbn/core-saved-objects-server';
import type { ExperimentalFeatures } from '../../../common';
import { referenceDataSavedObjectType } from '../lib/reference_data';
import { scriptsLibrarySavedObjectType } from '../lib/scripts_library';

/** Returns Endpoint's saved object types needed by response actions. */
export const getEndpointResponseActionsRunSavedObjectTypes = (
  experimentalFeatures: Pick<ExperimentalFeatures, 'responseActionsScriptLibraryManagement'>
): SavedObjectsType[] => [
  referenceDataSavedObjectType,
  ...(experimentalFeatures.responseActionsScriptLibraryManagement
    ? [scriptsLibrarySavedObjectType]
    : []),
];
