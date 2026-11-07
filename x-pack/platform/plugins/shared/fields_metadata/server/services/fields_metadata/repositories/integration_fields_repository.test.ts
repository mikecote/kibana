/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { IntegrationFieldsRepository } from './integration_fields_repository';

const field = { name: 'custom.logs.request_id', type: 'keyword', description: 'Request identity' };
const integrations = [{ id: 'custom', name: 'custom', version: '1.0.0' }];
const create = (integrationListExtractor = jest.fn().mockResolvedValue(integrations)) => {
  const integrationFieldsExtractor = jest
    .fn()
    .mockResolvedValue({ 'custom.logs': { [field.name]: field } });
  const repository = IntegrationFieldsRepository.create({
    integrationListExtractor,
    integrationFieldsExtractor,
  });
  const read = () =>
    repository.getByName(field.name, { integration: 'custom', dataset: 'custom.logs' });
  return { repository, read, integrationFieldsExtractor, integrationListExtractor };
};

describe('integration field metadata initialization', () => {
  it('waits for the catalog before answering the first lookup', async () => {
    const catalog = Promise.withResolvers<typeof integrations>();
    const fixture = create(jest.fn().mockReturnValue(catalog.promise));
    expect(fixture.integrationListExtractor).not.toHaveBeenCalled();
    let answered = false;
    const result = fixture.read().then((value) => {
      answered = true;
      return value;
    });
    await Promise.resolve();
    expect(answered).toBe(false);
    expect(fixture.integrationFieldsExtractor).not.toHaveBeenCalled();
    catalog.resolve(integrations);
    expect((await result)?.toPlain()).toEqual(
      expect.objectContaining({ ...field, source: 'integration' })
    );
  });

  it('shares catalog initialization across concurrent lookups', async () => {
    const catalog = Promise.withResolvers<typeof integrations>();
    const fixture = create(jest.fn().mockReturnValue(catalog.promise));
    const first = fixture.read();
    const second = fixture.read();
    expect(fixture.integrationListExtractor).toHaveBeenCalledTimes(1);
    catalog.resolve(integrations);
    const results = await Promise.all([first, second]);
    expect(results.map((value) => value?.toPlain().name)).toEqual([field.name, field.name]);
    await fixture.read();
    expect(fixture.integrationListExtractor).toHaveBeenCalledTimes(1);
  });

  it('propagates a failed catalog load and retries on the next lookup', async () => {
    const error = new Error('Package registry unavailable');
    const integrationListExtractor = jest
      .fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValue(integrations);
    const fixture = create(integrationListExtractor);
    await expect(fixture.read()).rejects.toBe(error);
    expect(fixture.integrationFieldsExtractor).not.toHaveBeenCalled();
    expect((await fixture.read())?.toPlain()).toEqual(
      expect.objectContaining({ name: field.name })
    );
    expect(integrationListExtractor).toHaveBeenCalledTimes(2);
  });
});
