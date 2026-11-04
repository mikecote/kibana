/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import { renderActionParameterTemplates } from './render_action_parameter_templates';

describe('renderActionParameterTemplates', () => {
  const logger = loggingSystemMock.createLogger();

  it('uses the renderer of the connector type when it has one', () => {
    const renderParameterTemplates = jest.fn().mockReturnValue({ rendered: true });
    const registry = { get: () => ({ renderParameterTemplates }) } as never;
    expect(
      renderActionParameterTemplates(logger, registry, '.test', 'id', { a: '{{x}}' }, { x: 1 })
    ).toEqual({ rendered: true });
    expect(renderParameterTemplates).toHaveBeenCalledWith(logger, { a: '{{x}}' }, { x: 1 }, 'id');
  });

  it('renders mustache templates otherwise', () => {
    const registry = { get: () => ({}) } as never;
    expect(
      renderActionParameterTemplates(logger, registry, '.test', 'id', { a: '{{x}}' }, { x: 1 })
    ).toEqual({ a: '1' });
  });
});
