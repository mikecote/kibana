/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import { REPO_ROOT } from '@kbn/repo-info';
import type { AgentBuilderContribution } from '@kbn/agent-builder-server';
import { collectRegisteredIds } from '../run_services/collect_registered_ids';
import { AGENT_BUILDER_CONTRIBUTIONS_KEY } from './agent_builder_contribution';

/**
 * Everything a plugin registers with agent builder in its `setup()` must be registered by a task
 * process too (the `agent-builder` contributions in `kibana.jsonc`), or the process differs from Kibana
 * and the runs that read the registries are declined. The ids are checked in: a plugin that registers
 * a new one changes the list, and a plugin that registers with agent builder without a contribution
 * fails the second test unless it is listed below. Regenerate the list with
 * `UPDATE_AGENT_BUILDER_CONTRIBUTION_IDS=1 node scripts/jest --config <agent builder jest config> <this file>`.
 */
const IDS_FILE = join(__dirname, 'agent_builder_contribution_ids.json');

/**
 * The plugins that register with agent builder and do not contribute yet, with what each needs in a
 * process. Move a plugin out of this list when it gets a contribution.
 */
const NOT_YET_CONTRIBUTED: Record<string, string> = {
  // Medium: one more service, built from explicit dependencies, or a registry of its own.
  'x-pack/platform/plugins/shared/agent_builder_dashboards':
    'the dashboard client (the dashboard state schema registry) and the embeddable plugin',
  'x-pack/platform/plugins/shared/agent_builder_workflows':
    'the workflows management API (and the SML types)',
  'x-pack/platform/plugins/shared/cases': 'the cases client, the rule registry and files',
  'x-pack/platform/plugins/shared/ml': 'the ML services (createMlRunServices)',
  'x-pack/platform/plugins/shared/alerting_v2': 'the v2 rules services',
  'x-pack/platform/plugins/shared/evals_skills': 'the evals task providers registry',
  'x-pack/platform/plugins/shared/proposals': 'the proposals client',
  'x-pack/platform/plugins/shared/context_engine_agent_builder': 'the context engine client',
  // Hard: services that only exist in Kibana, or many registrations that read them.
  'x-pack/platform/plugins/shared/streams': 'the streams client and its asset services',
  'x-pack/solutions/security/plugins/security_solution':
    'endpoint, detections and entity analytics services',
  'x-pack/solutions/security/plugins/discoveries': 'attack discovery services',
  'x-pack/solutions/security/plugins/alertzero': 'the investigations services',
  'x-pack/platform/plugins/shared/agentic_investigations': 'the investigations services',
  'x-pack/solutions/observability/plugins/observability_agent_builder':
    'the data providers other observability plugins register (apm, infra, slo, synthetics)',
  'x-pack/solutions/observability/plugins/significant_events': 'the significant events services',
  'x-pack/solutions/observability/plugins/nightshift_investigations':
    'the investigations client, the sandbox plugin and agent execution',
};

const git = (args: string) => execSync(`git ${args}`, { cwd: REPO_ROOT, encoding: 'utf8' });

/** The files of every plugin that lists one under the `agent-builder` key of its `kibana.jsonc`. */
const getContributionFiles = (): Array<{ plugin: string; file: string }> =>
  git(`grep -l '"${AGENT_BUILDER_CONTRIBUTIONS_KEY}"' -- '*kibana.jsonc'`)
    .split('\n')
    .filter(Boolean)
    .flatMap((manifest) => {
      const text = readFileSync(join(REPO_ROOT, manifest), 'utf8');
      const list = new RegExp(`"${AGENT_BUILDER_CONTRIBUTIONS_KEY}"\\s*:\\s*\\[([^\\]]*)\\]`).exec(
        text
      )?.[1];
      return [...(list ?? '').matchAll(/"([^"]+)"/g)].map(([, file]) => ({
        plugin: dirname(manifest),
        file: join(REPO_ROOT, dirname(manifest), file),
      }));
    });

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
    const settings = Object.fromEntries(
      contributions.flatMap(({ declares }) => (declares?.settings ?? []).map((id) => [id, {}]))
    );
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

  it('is implemented by every plugin that registers with agent builder, or the plugin is listed as not yet', () => {
    const contributing = new Set(getContributionFiles().map(({ plugin }) => plugin));
    const registering = getRegisteringPlugins().filter(
      (plugin) => plugin !== 'x-pack/platform/plugins/shared/agent_builder'
    );

    expect(
      registering.filter((plugin) => !contributing.has(plugin) && !(plugin in NOT_YET_CONTRIBUTED))
    ).toEqual([]);
    // A plugin that got its contribution leaves the list.
    expect(Object.keys(NOT_YET_CONTRIBUTED).filter((plugin) => contributing.has(plugin))).toEqual(
      []
    );
  });
});
