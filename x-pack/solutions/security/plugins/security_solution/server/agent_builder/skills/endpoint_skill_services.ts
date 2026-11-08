/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { EndpointAppContextService } from '../../endpoint/endpoint_app_context_services';

export type EndpointSkillServices =
  | EndpointAppContextService
  | (() => Promise<EndpointAppContextService>);

/** Resolves Endpoint dependencies when a skill's inline tools are requested. */
export const createEndpointInlineTools =
  <T>(
    services: EndpointSkillServices,
    createTools: (service: EndpointAppContextService) => T
  ): (() => T | Promise<T>) =>
  () =>
    typeof services === 'function' ? services().then(createTools) : createTools(services);
