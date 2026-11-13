/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { AiIndexRegistry } from '../ai_indices/registry';
import { createTaskProcessAiIndexRegistry } from './task_process_settings';

describe('managed AI index dispatch snapshot', () => {
  it('restores every registration and keeps the registry immutable after setup', () => {
    const registry = new AiIndexRegistry();
    const properties = {
      dest: { type: 'index' as const, value: 'knowledge' },
      automations: [],
      sources: [],
      traces: [],
    };
    registry.register('managed', properties);
    registry.freeze();
    const restored = createTaskProcessAiIndexRegistry({
      registrations: registry.getRegistrations(),
    });
    expect(restored.getManagedIds()).toEqual(['managed']);
    expect(restored.get('managed')).toEqual(properties);
    expect(() => restored.register('extra', properties)).toThrow('after plugin setup');
  });

  it('does not carry registrations into the next execution', () => {
    const next = createTaskProcessAiIndexRegistry({ registrations: [] });
    expect(next.getManagedIds()).toEqual([]);
    expect(next.has('managed')).toBe(false);
  });

  it('fails explicitly when Kibana did not send its registry', () => {
    expect(() => createTaskProcessAiIndexRegistry(undefined)).toThrow(
      'did not receive the managed AI index registry'
    );
  });
});
