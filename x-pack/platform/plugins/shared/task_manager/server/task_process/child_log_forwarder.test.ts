/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { PassThrough } from 'stream';
import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import { forwardChildLogs, getChildLogLevel } from './child_log_forwarder';

describe('child logs', () => {
  const setup = () => {
    const logger = loggingSystemMock.createLogger();
    const stream = new PassThrough();
    forwardChildLogs({ stream, logger, labels: { task_type: 'a:b', run_id: 'r1' } });
    const write = async (line: string) => {
      stream.write(`${line}\n`);
      await new Promise((resolve) => setImmediate(resolve));
    };
    return { logger, write };
  };

  it("logs a record with Kibana's logger at its level, labelled with the task type and run", async () => {
    const { logger, write } = setup();
    await write(
      JSON.stringify({ message: 'hello', log: { level: 'WARN', logger: 'plugins.alerting' } })
    );
    expect(logger.warn).toHaveBeenCalledWith('hello', {
      labels: { task_type: 'a:b', run_id: 'r1', child_logger: 'plugins.alerting' },
    });
  });

  it('keeps the stack trace of an error record', async () => {
    const { logger, write } = setup();
    await write(
      JSON.stringify({
        message: 'bad',
        log: { level: 'ERROR' },
        error: { message: 'm', type: 'Error', stack_trace: 'Error: m\n  at x' },
      })
    );
    expect(logger.error).toHaveBeenCalledWith(
      'bad\nError: m\n  at x',
      expect.objectContaining({ error: { message: 'm', type: 'Error' } })
    );
  });

  it('logs a line that is not a record as it is', async () => {
    const { logger, write } = setup();
    await write('Segmentation fault');
    expect(logger.info).toHaveBeenCalledWith('Segmentation fault', {
      labels: { task_type: 'a:b', run_id: 'r1' },
    });
  });

  it('asks the child for the lowest level Kibana logs', () => {
    const at = (min: string) => ({
      isLevelEnabled: (level: string) =>
        ['trace', 'debug', 'info', 'warn', 'error', 'fatal'].indexOf(level) >=
        ['trace', 'debug', 'info', 'warn', 'error', 'fatal'].indexOf(min),
    });
    expect(getChildLogLevel(at('info') as never)).toBe('info');
    expect(getChildLogLevel(at('debug') as never)).toBe('debug');
  });
});
