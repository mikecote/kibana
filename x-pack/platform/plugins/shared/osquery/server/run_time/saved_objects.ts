/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { packType, savedQueryType, packAssetType } from '../lib/saved_query/saved_object_mappings';

/** Returns the saved object types a task process needs for live queries. */
export const getOsqueryRunSavedObjectTypes = () => [savedQueryType, packType, packAssetType];
