/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { joinWithDash } from './utils';

/** Resolves the native namespaced alias from the owning rule data client's base index name. */
export const getNamespacedRuleDataAlias = (indexName: string, namespace: string): string =>
  joinWithDash(indexName, namespace);
