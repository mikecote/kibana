/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { firstValueFrom, Observable } from 'rxjs';
import { TelemetryConfigProvider } from './telemetry_config_provider';

describe('TelemetryConfigProvider', () => {
  let telemetryConfigProvider: TelemetryConfigProvider;

  beforeEach(() => {
    telemetryConfigProvider = new TelemetryConfigProvider();
  });

  describe('getIsOptedIn()', () => {
    it.each([true, false])(
      'restores the current value and observable from snapshot %s',
      async (value) => {
        const provider = new TelemetryConfigProvider(value);
        const observable = provider.getObservable();
        if (!observable) throw new Error('A captured telemetry value must have an observable');
        expect(provider.getIsOptedIn()).toBe(value);
        expect(await firstValueFrom(observable)).toBe(value);
        provider.stop();
      }
    );
    it('returns undefined when object is uninitialized', () => {
      expect(telemetryConfigProvider.getIsOptedIn()).toBe(undefined);
    });

    it.each([true, false])('returns pushed %s value after subscribed', (value) => {
      const observable$ = new Observable<boolean>((subscriber) => {
        subscriber.next(value);
      });

      telemetryConfigProvider.start(observable$);

      expect(telemetryConfigProvider.getIsOptedIn()).toBe(value);
    });
  });

  it('stop() unsubscribes from Observable', async () => {
    const unsubscribeMock = jest.fn();
    const observableMock = {
      subscribe: () => ({
        unsubscribe: unsubscribeMock,
      }),
    } as unknown as Observable<boolean>;

    telemetryConfigProvider.start(observableMock);
    expect(unsubscribeMock).not.toHaveBeenCalled();

    telemetryConfigProvider.stop();
    expect(unsubscribeMock).toHaveBeenCalled();
  });
});
