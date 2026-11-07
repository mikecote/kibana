/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { loggerMock } from '@kbn/logging-mocks';

import { createFleetFieldsMetadataExtractors } from './register_fields_metadata_extractors';

const create = () => {
  const packages = {
    getPackageFieldsMetadata: jest.fn().mockResolvedValue({ logs: {} }),
    getPackages: jest
      .fn()
      .mockResolvedValue([
        { id: 'custom', name: 'custom', version: '1.0.0', description: 'Extra package metadata' },
      ]),
  };
  const logger = loggerMock.create();
  const getPackageService = jest.fn().mockResolvedValue(packages);
  return {
    packages,
    logger,
    getPackageService,
    extractors: createFleetFieldsMetadataExtractors({ getPackageService, getLogger: () => logger }),
  };
};

describe('Fleet field metadata execution extractors', () => {
  it('resolves the package client lazily and preserves the native field and catalog payloads', async () => {
    const fixture = create();
    expect(fixture.getPackageService).not.toHaveBeenCalled();
    await expect(
      fixture.extractors.integrationFieldsExtractor({
        integration: 'custom',
        dataset: 'custom.logs',
      })
    ).resolves.toEqual({ logs: {} });
    expect(fixture.packages.getPackageFieldsMetadata).toHaveBeenCalledWith({
      packageName: 'custom',
      datasetName: 'custom.logs',
    });
    await expect(fixture.extractors.integrationListExtractor()).resolves.toEqual([
      { id: 'custom', name: 'custom', version: '1.0.0' },
    ]);
    expect(fixture.getPackageService).toHaveBeenCalledTimes(2);
  });

  it('propagates failed package field reads with the native logging policy', async () => {
    const fixture = create();
    const error = new Error('Archive unavailable');
    fixture.packages.getPackageFieldsMetadata.mockRejectedValue(error);
    await expect(
      fixture.extractors.integrationFieldsExtractor({ integration: 'custom' })
    ).rejects.toBe(error);
    expect(fixture.logger.warn).not.toHaveBeenCalled();
  });

  it('logs and propagates a failed start-service lookup for field extraction', async () => {
    const fixture = create();
    const error = new Error('Start services unavailable');
    fixture.getPackageService.mockRejectedValue(error);
    await expect(
      fixture.extractors.integrationFieldsExtractor({ integration: 'custom' })
    ).rejects.toBe(error);
    expect(fixture.logger.warn).toHaveBeenCalledWith(expect.stringContaining(error.message));
  });

  it('preserves the native catalog error policy after resolving start services', async () => {
    const fixture = create();
    fixture.packages.getPackages.mockRejectedValue(new Error('Registry unavailable'));
    await expect(fixture.extractors.integrationListExtractor()).resolves.toEqual([]);
    const startup = new Error('Start services unavailable');
    fixture.getPackageService.mockRejectedValue(startup);
    await expect(fixture.extractors.integrationListExtractor()).rejects.toBe(startup);
  });
});
