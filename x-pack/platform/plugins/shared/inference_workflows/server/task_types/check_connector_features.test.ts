/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { checkConnectorFeatures } from './check_connector_features';

const known = (id: string) => id === 'known';

describe('checkConnectorFeatures', () => {
  it('accepts steps without features and with registered ones', () => {
    expect(checkConnectorFeatures({}, known)).toBeUndefined();
    expect(checkConnectorFeatures({ 'connector-id-by-feature': 'known' }, known)).toBeUndefined();
    expect(
      checkConnectorFeatures({ 'connector-id-by-feature': ['known', ' '] }, known)
    ).toBeUndefined();
  });

  it('declines a feature the process does not know', () => {
    expect(
      checkConnectorFeatures({ 'connector-id-by-feature': ['known', 'other'] }, known)
    ).toMatch(/"other" is not registered/);
  });

  it('declines a templated feature', () => {
    expect(
      checkConnectorFeatures({ 'connector-id-by-feature': '{{ inputs.feature }}' }, known)
    ).toMatch(/template/);
  });
});
