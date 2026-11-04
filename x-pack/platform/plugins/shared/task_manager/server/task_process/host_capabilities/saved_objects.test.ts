/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { elasticsearchServiceMock } from '@kbn/core-elasticsearch-server-mocks';
import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import type { KibanaRequest } from '@kbn/core-http-server';
import { createStandaloneSavedObjects, StandaloneSpacesExtension } from './saved_objects';

const type = {
  name: 'test-type',
  hidden: true,
  namespaceType: 'multiple-isolated' as const,
  mappings: { properties: { name: { type: 'keyword' as const } } },
};

describe('StandaloneSpacesExtension', () => {
  it('resolves the namespace from the space of the request', () => {
    expect(new StandaloneSpacesExtension('default').getCurrentNamespace(undefined)).toBe(undefined);
    expect(new StandaloneSpacesExtension('my-space').getCurrentNamespace(undefined)).toBe(
      'my-space'
    );
  });

  it('honours an explicit namespace and uses the given namespaces as they are', async () => {
    const extension = new StandaloneSpacesExtension('my-space');
    expect(extension.getCurrentNamespace('other')).toBe('other');
    await expect(extension.getSearchableNamespaces(['a', 'b'])).resolves.toEqual(['a', 'b']);
    await expect(extension.getSearchableNamespaces(undefined)).resolves.toEqual(['my-space']);
    expect(extension.asScopedToNamespace('x')).toBeInstanceOf(StandaloneSpacesExtension);
  });
});

describe('createStandaloneSavedObjects', () => {
  const create = (types = [type]) =>
    createStandaloneSavedObjects({
      types,
      client: elasticsearchServiceMock.createElasticsearchClient(),
      logger: loggingSystemMock.createLogger(),
      kibanaVersion: '9.9.9',
    });

  it('exposes the registry of the types it was given, once each', () => {
    const { savedObjects } = create([type, type]);
    expect(
      savedObjects
        .getTypeRegistry()
        .getAllTypes()
        .map((t) => t.name)
    ).toEqual(['test-type']);
  });

  it('builds scoped and internal clients for hidden types it knows and ignores the rest', () => {
    const { savedObjects } = create();
    const request = { headers: {}, spaceId: 'my-space' } as unknown as KibanaRequest;
    expect(
      savedObjects.getScopedClient(request, { includedHiddenTypes: ['test-type', 'unknown'] })
    ).toBeDefined();
    expect(
      savedObjects.getUnsafeInternalClient({ includedHiddenTypes: ['test-type', 'unknown'] })
    ).toBeDefined();
    expect(savedObjects.createInternalRepository(['unknown'])).toBeDefined();
  });

  it('rejects an encryption extension set after the first client', () => {
    const { savedObjects, setEncryptionExtension } = create();
    setEncryptionExtension(() => undefined as never);
    savedObjects.getScopedClient({ headers: {} } as unknown as KibanaRequest);
    expect(() => setEncryptionExtension(() => undefined as never)).toThrow(
      /before the first client/
    );
  });
});
