/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { getWorkflowDataStreamDefinitions, registerWorkflowDataStreams } from './data_streams';

describe('workflow data streams', () => {
  it('lists the logs and trigger events definitions for plain index storage', () => {
    const definitions = getWorkflowDataStreamDefinitions({
      source: 'plain_index',
      dataRetention: '90d',
    });
    expect(Object.keys(definitions).sort()).toEqual([
      '.workflows-events',
      '.workflows-execution-data-stream-logs',
    ]);
    for (const [name, definition] of Object.entries(definitions)) {
      expect(definition.name).toBe(name);
      expect(definition.version).toBeGreaterThan(0);
    }
  });

  it('adds the execution data streams, with the configured retention, for data stream storage', () => {
    const definitions = getWorkflowDataStreamDefinitions({
      source: 'data_stream',
      dataRetention: '30d',
    });
    expect(Object.keys(definitions)).toHaveLength(4);
    const executions = Object.values(definitions).filter(
      (definition) => definition.template?.lifecycle?.data_retention
    );
    expect(executions).toHaveLength(2);
    for (const definition of executions) {
      expect(definition.template?.lifecycle?.data_retention).toBe('30d');
    }
  });

  it('registers every definition with Core', () => {
    const dataStreams = { registerDataStream: jest.fn() };
    registerWorkflowDataStreams({ dataStreams }, { source: 'data_stream', dataRetention: '90d' });
    expect(dataStreams.registerDataStream).toHaveBeenCalledTimes(4);
    registerWorkflowDataStreams({ dataStreams }, { source: 'plain_index', dataRetention: '90d' });
    expect(dataStreams.registerDataStream).toHaveBeenCalledTimes(6);
  });
});
