/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { KibanaRequest } from '@kbn/core/server';

export const getSpaceId = ({
  request,
  spaces,
}: {
  request: KibanaRequest;
  /** The spaces service of the spaces plugin, or what a task process answers with. */
  spaces: { getSpaceId: (request: KibanaRequest) => string } | undefined | null;
}): string => spaces?.getSpaceId(request) ?? 'default';
