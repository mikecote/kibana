/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import {
  EncryptionError,
  EncryptionErrorOperation,
} from '@kbn/encrypted-saved-objects-plugin/server';
import { elasticsearchServiceMock } from '@kbn/core-elasticsearch-server-mocks';
import { createStandaloneEncryptedSavedObjects } from './encrypted_saved_objects';
import { createStandaloneSavedObjects } from './saved_objects';

const KEY = 'a'.repeat(32);

describe('createStandaloneEncryptedSavedObjects', () => {
  const create = (keys?: { encryptionKey?: string; decryptionOnlyKeys: string[] }) => {
    const logger = loggingSystemMock.createLogger();
    const standalone = createStandaloneSavedObjects({
      types: [
        {
          name: 'secret-type',
          hidden: true,
          namespaceType: 'multiple-isolated',
          mappings: { properties: { apiKey: { type: 'binary' } } },
        },
      ],
      client: elasticsearchServiceMock.createElasticsearchClient(),
      logger,
      kibanaVersion: '9.9.9',
    });
    const eso = createStandaloneEncryptedSavedObjects({
      keys,
      registrations: [{ type: 'secret-type', attributesToEncrypt: new Set(['apiKey']) }],
      standalone,
      logger,
    });
    return { eso, logger };
  };

  it('can encrypt with a key, and builds a client that decrypts', () => {
    const { eso } = create({ encryptionKey: KEY, decryptionOnlyKeys: [] });
    expect(eso.canEncrypt).toBe(true);
    expect(
      eso.getClient({ includedHiddenTypes: ['secret-type'] }).getDecryptedAsInternalUser
    ).toEqual(expect.any(Function));
  });

  it('warns without a key', () => {
    const { eso, logger } = create();
    expect(eso.canEncrypt).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('encryptionKey is not set'));
  });

  it('refuses a key that is too short, like the plugin does', () => {
    expect(() => create({ encryptionKey: 'short', decryptionOnlyKeys: [] })).toThrow();
  });

  it('recognizes encryption errors', () => {
    const { eso } = create({ encryptionKey: KEY, decryptionOnlyKeys: [] });
    expect(
      eso.isEncryptionError(new EncryptionError('x', 'apiKey', EncryptionErrorOperation.Decryption))
    ).toBe(true);
    expect(eso.isEncryptionError(new Error('x'))).toBe(false);
  });
});
