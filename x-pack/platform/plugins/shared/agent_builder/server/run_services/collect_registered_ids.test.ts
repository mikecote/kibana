/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import type { AgentBuilderContribution } from '@kbn/agent-builder-server';
import { collectRegisteredIds } from './collect_registered_ids';

describe('collectRegisteredIds', () => {
  const logger = loggingSystemMock.createLogger();

  it('registers what a contribution registers at start, from the current settings Kibana sent', async () => {
    const ensure = jest.fn();
    const contribution: AgentBuilderContribution = {
      declares: { settings: ['flagged'] },
      register: () => {},
      registerAtStart: async (start, { settings }) => {
        // The set Kibana decided for this dispatch: the skill exists only while the flag is on.
        if ((settings.flagged as { on: boolean }).on) {
          await start.skills.register({ id: 'flagged-skill' } as never);
        }
        await start.agents.ensure({ spaceId: 'default', agent: { id: 'flagged-agent' } as never });
        ensure();
      },
    };

    const on = await collectRegisteredIds({
      contributions: [contribution],
      settings: { flagged: { on: true } },
      logger,
    });
    const off = await collectRegisteredIds({
      contributions: [contribution],
      settings: { flagged: { on: false } },
      logger,
    });

    expect(on.skills).toContain('flagged-skill');
    expect(off.skills).not.toContain('flagged-skill');
    expect(ensure).toHaveBeenCalledTimes(2);
  });
});
