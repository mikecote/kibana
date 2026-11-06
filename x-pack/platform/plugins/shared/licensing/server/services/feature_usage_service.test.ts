/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { loggingSystemMock } from '@kbn/core/server/mocks';
import { FeatureUsageService } from './feature_usage_service';
import { FeatureUsageStore } from './feature_usage_store';

describe('FeatureUsageService', () => {
  let service: FeatureUsageService;

  beforeEach(() => {
    service = new FeatureUsageService();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('#setup', () => {
    describe('#register', () => {
      it('does not throw when registering the same feature twice with the same license', () => {
        const setup = service.setup();
        setup.register('foo', 'basic');
        expect(() => {
          setup.register('foo', 'basic');
        }).not.toThrow();
      });

      it('throws when registering the same feature again with a different license', () => {
        const setup = service.setup();
        setup.register('foo', 'basic');
        expect(() => {
          setup.register('foo', 'enterprise');
        }).toThrowErrorMatchingInlineSnapshot(
          `"Feature 'foo' has already been registered with another license type. (current: basic, new: enterprise)"`
        );
      });
    });
  });

  describe('#start', () => {
    describe('#notifyUsage', () => {
      it('allows to notify a feature usage', async () => {
        const setup = service.setup();
        setup.register('feature', 'basic');
        const start = service.start();
        start.notifyUsage('feature', 127001);

        expect(await start.getLastUsages()).toEqual([
          {
            lastUsed: new Date(127001),
            licenseType: 'basic',
            id: 'feature',
          },
        ]);
      });

      it('can receive a Date object', async () => {
        const setup = service.setup();
        setup.register('feature', 'basic');
        const start = service.start();

        const usageTime = new Date(2015, 9, 21, 17, 54, 12);
        start.notifyUsage('feature', usageTime);
        expect(await start.getLastUsages()).toEqual([
          {
            lastUsed: usageTime,
            licenseType: 'basic',
            id: 'feature',
          },
        ]);
      });

      it('uses the current time when `usedAt` is unspecified', async () => {
        jest.spyOn(Date, 'now').mockReturnValue(42);

        const setup = service.setup();
        setup.register('feature', 'basic');
        const start = service.start();
        start.notifyUsage('feature');

        expect(await start.getLastUsages()).toEqual([
          {
            lastUsed: new Date(42),
            licenseType: 'basic',
            id: 'feature',
          },
        ]);
      });

      it('throws when notifying for an unregistered feature', () => {
        service.setup();
        const start = service.start();
        expect(() => {
          start.notifyUsage('unregistered');
        }).toThrowErrorMatchingInlineSnapshot(`"Feature 'unregistered' is not registered."`);
      });
    });

    describe('#getLastUsages', () => {
      it('returns the last usage for all used features', async () => {
        const setup = service.setup();
        setup.register('featureA', 'basic');
        setup.register('featureB', 'gold');
        const start = service.start();
        start.notifyUsage('featureA', 127001);
        start.notifyUsage('featureB', 6666);

        expect(await start.getLastUsages()).toEqual([
          { lastUsed: new Date(127001), licenseType: 'basic', id: 'featureA' },
          { lastUsed: new Date(6666), licenseType: 'gold', id: 'featureB' },
        ]);
      });

      it('returns the last usage even after notifying for an older usage', async () => {
        const setup = service.setup();
        setup.register('featureA', 'basic');
        const start = service.start();
        start.notifyUsage('featureA', 1000);
        start.notifyUsage('featureA', 500);

        expect(await start.getLastUsages()).toEqual([
          { lastUsed: new Date(1000), licenseType: 'basic', id: 'featureA' },
        ]);
      });

      it('returns entries for unused registered features', async () => {
        const setup = service.setup();
        setup.register('featureA', 'basic');
        setup.register('featureB', 'gold');
        const start = service.start();
        start.notifyUsage('featureA', 127001);

        expect(await start.getLastUsages()).toEqual([
          { lastUsed: new Date(127001), licenseType: 'basic', id: 'featureA' },
          { lastUsed: null, licenseType: 'gold', id: 'featureB' },
        ]);
      });
    });
  });

  describe('with a store shared by every node and process', () => {
    const createStore = (stored: Record<string, string> = {}) => {
      const repository = {
        update: jest.fn().mockResolvedValue({}),
        find: jest.fn().mockResolvedValue({
          saved_objects: Object.entries(stored).map(([id, lastUsed]) => ({
            id,
            attributes: { lastUsed },
          })),
        }),
      };
      return {
        repository,
        store: new FeatureUsageStore(repository, loggingSystemMock.createLogger()),
      };
    };

    afterEach(async () => {
      await service.stop();
    });

    it('stores what this node used when it flushes', async () => {
      const { repository, store } = createStore();
      const setup = service.setup();
      setup.register('featureA', 'basic');
      const start = service.start({ store, flushIntervalMs: 60_000 });

      start.notifyUsage('featureA', 1000);
      start.notifyUsage('featureA', 3000);
      start.notifyUsage('featureA', 2000);
      await store.flush();

      expect(repository.update).toHaveBeenCalledTimes(1);
      expect(repository.update).toHaveBeenCalledWith(
        'licensing-feature-usage',
        'featureA',
        { lastUsed: new Date(3000).toISOString() },
        { upsert: { lastUsed: new Date(3000).toISOString() } }
      );
    });

    it('returns what another node or process used when it is more recent than this node', async () => {
      const { store } = createStore({
        featureA: new Date(5000).toISOString(),
        featureB: new Date(100).toISOString(),
        // Registered on another node only: its license type is unknown here.
        featureC: new Date(7000).toISOString(),
      });
      const setup = service.setup();
      setup.register('featureA', 'basic');
      setup.register('featureB', 'gold');
      setup.register('featureD', 'gold');
      const start = service.start({ store, flushIntervalMs: 60_000 });
      start.notifyUsage('featureB', 900);

      expect(await start.getLastUsages()).toEqual([
        { lastUsed: new Date(5000), licenseType: 'basic', id: 'featureA' },
        { lastUsed: new Date(900), licenseType: 'gold', id: 'featureB' },
        { lastUsed: null, licenseType: 'gold', id: 'featureD' },
      ]);
    });

    it('writes what is left when the node stops', async () => {
      const { repository, store } = createStore();
      service.setup().register('featureA', 'basic');
      service.start({ store, flushIntervalMs: 60_000 }).notifyUsage('featureA', 1000);

      await service.stop();

      expect(repository.update).toHaveBeenCalledTimes(1);
    });
  });
});

describe('FeatureUsageStore', () => {
  const logger = loggingSystemMock.createLogger();

  it('keeps what it failed to write for the next flush, without throwing', async () => {
    const repository = {
      update: jest.fn().mockRejectedValueOnce(new Error('es down')).mockResolvedValue({}),
      find: jest.fn(),
    };
    const store = new FeatureUsageStore(repository, logger);
    store.record('feature', new Date(1000));

    await expect(store.flush()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('es down'));

    await store.flush();
    expect(repository.update).toHaveBeenCalledTimes(2);
  });

  it('does not write when nothing was recorded', async () => {
    const repository = { update: jest.fn(), find: jest.fn() };

    await new FeatureUsageStore(repository, logger).flush();

    expect(repository.update).not.toHaveBeenCalled();
  });
});
