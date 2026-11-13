/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { join, relative } from 'path';
import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import { REPO_ROOT } from '@kbn/repo-info';
import { getRemoteContributions } from '@kbn/import-locator';
import type { AgentBuilderContribution } from '@kbn/agent-builder-server';
import { collectRegisteredIds } from '../run_services/collect_registered_ids';
import { getExampleContributionSettings } from './example_contribution_settings';
import { AGENT_BUILDER_CONTRIBUTIONS_KEY } from './agent_builder_contribution';

/**
 * Everything a plugin registers with agent builder in its `setup()` must be registered by a task
 * process too (the `agent-builder` contributions in `server/remote/index.ts`), or the process differs from Kibana
 * and the runs that read the registries are declined. The ids are checked in: a plugin that registers
 * a new one changes the list, and a plugin that registers with agent builder without a contribution
 * fails the coverage test. Regenerate the list with
 * `UPDATE_AGENT_BUILDER_CONTRIBUTION_IDS=1 node scripts/jest --config <agent builder jest config> <this file>`.
 */
const IDS_FILE = join(__dirname, 'agent_builder_contribution_ids.json');

const git = (args: string) => execSync(`git ${args}`, { cwd: REPO_ROOT, encoding: 'utf8' });

/** The files declared under the contribution key in convention-discovered remote manifests. */
const getContributionFiles = (): Array<{ plugin: string; file: string }> =>
  getRemoteContributions(REPO_ROOT, AGENT_BUILDER_CONTRIBUTIONS_KEY).map(
    ({ directory, modulePath }) => ({
      plugin: relative(REPO_ROOT, directory),
      file: modulePath,
    })
  );

/** The plugins whose server code takes the setup contract of agent builder (what they register with). */
const getRegisteringPlugins = (): string[] => [
  ...new Set(
    git(
      `grep -lE "(^|[^A-Za-z])AgentBuilderPluginSetup" -- '*/server/*.ts' ':!*test*' ':!*/target/*'`
    )
      .split('\n')
      .filter(Boolean)
      .map((file) => file.replace(/\/server\/.*$/, ''))
  ),
];

describe('the agent-builder contributions', () => {
  const logger = loggingSystemMock.createLogger();
  const contributions = getContributionFiles().map(
    ({ file }) =>
      (jest.requireActual(file) as { contribution: AgentBuilderContribution }).contribution
  );

  it('registers the ids that are checked in', async () => {
    // Every plugin is enabled: what Kibana sends is whatever each contribution declares it reads.
    const settings = getExampleContributionSettings(contributions);
    const ids = await collectRegisteredIds({ contributions, settings, logger });

    if (process.env.UPDATE_AGENT_BUILDER_CONTRIBUTION_IDS) {
      writeFileSync(IDS_FILE, `${JSON.stringify(ids, null, 2)}\n`);
    }
    expect(ids).toEqual(JSON.parse(readFileSync(IDS_FILE, 'utf8')));
  });

  it('registers nothing for a plugin that is not enabled in Kibana', async () => {
    // Only what agent builder registers itself.
    expect(await collectRegisteredIds({ contributions, settings: {}, logger })).toEqual(
      await collectRegisteredIds({ contributions: [], settings: {}, logger })
    );
  });

  it('is implemented by every plugin that registers with agent builder', () => {
    const contributing = new Set(getContributionFiles().map(({ plugin }) => plugin));
    const registering = getRegisteringPlugins().filter(
      (plugin) => plugin !== 'x-pack/platform/plugins/shared/agent_builder'
    );
    expect(registering.filter((plugin) => !contributing.has(plugin))).toEqual([]);
  });
});
