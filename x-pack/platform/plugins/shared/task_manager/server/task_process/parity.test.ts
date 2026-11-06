/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { DeclinedRunError } from '../task_running/errors';
import { createParityGuard, findMissingParity } from './parity';

describe('findMissingParity', () => {
  it('names the ids Kibana has that the process lacks, by kind', () => {
    expect(
      findMissingParity(
        [
          { kind: 'connectorTypes', ids: ['.email', '.slack', '.new'] },
          { kind: 'connectorAdapters', ids: ['.cases'] },
        ],
        { connectorTypes: ['.email', '.slack', '.extra'], connectorAdapters: ['.cases'] }
      )
    ).toEqual([{ kind: 'connectorTypes', ids: ['.new'] }]);
  });

  it('does not compare a kind the process has no hook for', () => {
    expect(findMissingParity([{ kind: 'other', ids: ['a'] }], {})).toEqual([]);
  });
});

describe('createParityGuard', () => {
  const logger = { warn: jest.fn(), debug: jest.fn() };
  const host = {} as never;
  beforeEach(() => jest.clearAllMocks());

  it('lets a run through when the process registered what Kibana did, reading the ids once', async () => {
    const getIds = jest.fn().mockResolvedValue(['.email', '.slack']);
    const guard = createParityGuard({
      hooks: [{ kind: 'connectorTypes', getIds }],
      expected: [{ kind: 'connectorTypes', ids: ['.email'] }],
      logger,
      taskType: 'alerting:test',
    });
    await guard(host);
    await guard(host);
    expect(getIds).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('declines every run, and warns once with the missing ids, when the process lacks any', async () => {
    const guard = createParityGuard({
      hooks: [{ kind: 'connectorTypes', getIds: () => ['.email'] }],
      expected: [{ kind: 'connectorTypes', ids: ['.email', '.brand-new'] }],
      logger,
      taskType: 'alerting:test',
    });
    await expect(guard(host)).rejects.toBeInstanceOf(DeclinedRunError);
    await expect(guard(host)).rejects.toThrow('connectorTypes [.brand-new]');
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('.brand-new'));
  });

  it('checks nothing when Kibana sent no parity, as for a remote process', async () => {
    const getIds = jest.fn();
    const guard = createParityGuard({
      hooks: [{ kind: 'connectorTypes', getIds }],
      logger,
      taskType: 'alerting:test',
    });
    await guard(host);
    expect(getIds).not.toHaveBeenCalled();
  });

  it('checks nothing for a module without hooks', async () => {
    const guard = createParityGuard({
      expected: [{ kind: 'connectorTypes', ids: ['.email'] }],
      logger,
      taskType: 'task_manager:x',
    });
    await expect(guard(host)).resolves.toBeUndefined();
  });
});
