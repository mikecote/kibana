/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import Boom from '@hapi/boom';
import { i18n } from '@kbn/i18n';

/** Resolves a registered rule descriptor using the native missing-rule error. */
export const getRegisteredRuleType = <Descriptor extends object>(
  registry: ReadonlyMap<string, Descriptor>,
  id: string
): Descriptor => {
  const descriptor = registry.get(id);
  if (!descriptor) {
    throw Boom.badRequest(
      i18n.translate('xpack.alerting.ruleTypeRegistry.get.missingRuleTypeError', {
        defaultMessage: 'Rule type "{id}" is not registered.',
        values: { id },
      })
    );
  }
  return descriptor;
};
