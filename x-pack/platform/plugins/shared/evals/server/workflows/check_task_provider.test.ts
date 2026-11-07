/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { checkEvalsTaskProvider } from './check_task_provider';

const known = (name: string) => name === 'inference';

describe('checkEvalsTaskProvider', () => {
  it('accepts evals steps without a task ref, with a known one, and other steps', () => {
    expect(
      checkEvalsTaskProvider({ type: 'ai.evals.executeTask', config: { with: {} } }, known)
    ).toBeUndefined();
    expect(
      checkEvalsTaskProvider(
        { type: 'ai.evals.executeTask', config: { with: { task_ref: 'inference' } } },
        known
      )
    ).toBeUndefined();
    expect(
      checkEvalsTaskProvider({ type: 'ai.prompt', config: { with: { task_ref: 'other' } } }, known)
    ).toBeUndefined();
  });

  it('declines a provider the process does not have, also inside `task`', () => {
    expect(
      checkEvalsTaskProvider(
        { type: 'ai.evals.executeTask', config: { with: { task_ref: 'suite' } } },
        known
      )
    ).toMatch(/"suite" is not registered/);
    expect(
      checkEvalsTaskProvider(
        { type: 'ai.evals.evaluateDataset', config: { with: { task: { task_ref: 'suite' } } } },
        known
      )
    ).toMatch(/"suite" is not registered/);
  });

  it('resolves a templated task ref when the step runs', () => {
    expect(
      checkEvalsTaskProvider(
        { type: 'ai.evals.executeTask', config: { with: { task_ref: '{{ inputs.ref }}' } } },
        known
      )
    ).toBeUndefined();
  });
});
