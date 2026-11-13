/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { dirname, join, relative } from 'path';
import { of } from 'rxjs';
import { REPO_ROOT } from '@kbn/repo-info';
import { getRemoteContributions } from '@kbn/import-locator';
import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import { savedObjectsServiceMock } from '@kbn/core-saved-objects-server-mocks';
import { elasticsearchServiceMock } from '@kbn/core-elasticsearch-server-mocks';
import type { ILicense } from '@kbn/licensing-types';
import { configSchema as actionsConfigSchema } from '@kbn/actions-plugin/server/config';
import { createRuleRunActions } from '@kbn/actions-plugin/server/task_types/rule_run_actions';
import type { RuleRunContribution } from './rule_run_contribution';
import { RULE_RUN_CONTRIBUTIONS } from './rule_run_contribution';

/**
 * Every connector type and connector adapter that a plugin registers in its `setup()` must be
 * registered by a rule run in a task process too (the `alerting-rule-run` contributions in
 * `server/remote/index.ts`), or a rule that uses it is declined and Kibana runs it. The ids are checked in:
 * a plugin that registers a new one changes the list, and a plugin that registers one without a
 * contribution fails the second test. Regenerate the list with
 * `UPDATE_RULE_RUN_CONNECTOR_IDS=1 node scripts/jest --config <alerting jest config> <this file>`.
 */
const IDS_FILE = join(__dirname, 'rule_run_connector_type_ids.json');

const license = {
  isActive: true,
  type: 'platinum',
  check: () => ({ state: 'valid' }),
  hasAtLeast: () => true,
  getFeature: () => ({ isAvailable: true, isEnabled: true }),
  getUnavailableReason: () => undefined,
  isAvailable: true,
} as unknown as ILicense;

const git = (args: string) => execSync(`git ${args}`, { cwd: REPO_ROOT, encoding: 'utf8' });

/** The files declared under the contribution key in convention-discovered remote manifests. */
const getContributionFiles = (): Array<{ plugin: string; file: string }> =>
  getRemoteContributions(REPO_ROOT, RULE_RUN_CONTRIBUTIONS).map(({ directory, modulePath }) => ({
    plugin: relative(REPO_ROOT, directory),
    file: modulePath,
  }));

const registerContributions = () => {
  const contributions = getContributionFiles().map(
    ({ file }) => (jest.requireActual(file) as { contribution: RuleRunContribution }).contribution
  );
  const adapterIds: string[] = [];
  const logger = loggingSystemMock.createLogger();
  const { getActionTypeIds, stop } = createRuleRunActions({
    logger,
    config: actionsConfigSchema.validate({}),
    license$: of(license),
    elasticsearch: elasticsearchServiceMock.createStart().client,
    savedObjects: savedObjectsServiceMock.createStartContract(),
    getEncryptedSavedObjectsClient: jest.fn().mockReturnValue({}),
    taskManager: { bulkSchedule: jest.fn(), aggregate: jest.fn() },
    registerConnectorTypes: (actions, { publicBaseUrl }) =>
      contributions.forEach((contribution) =>
        contribution.register?.(
          {
            actions,
            alerting: {
              registerConnectorAdapter: (adapter: { connectorTypeId: string }) =>
                adapterIds.push(adapter.connectorTypeId),
            },
          } as never,
          {
            logger,
            isServerless: false,
            kibanaVersion: '9.9.9',
            publicBaseUrl,
            host: {} as never,
            // What the plugins that contribute are sent: cases reads its own settings.
            settings: {
              cases: {
                isCasesAttachmentsEnabled: true,
                isTemplatesEnabled: true,
              },
            },
          }
        )
      ),
  });
  const connectorTypes = getActionTypeIds();
  stop();
  return { connectorTypes: connectorTypes.sort(), connectorAdapters: adapterIds.sort() };
};

describe('the connector types a rule run in a task process registers', () => {
  it('are the ones plugins register in Kibana, checked in', () => {
    const registered = registerContributions();
    if (process.env.UPDATE_RULE_RUN_CONNECTOR_IDS) {
      writeFileSync(IDS_FILE, `${JSON.stringify(registered, null, 2)}\n`);
    }
    expect(registered).toEqual(JSON.parse(readFileSync(IDS_FILE, 'utf8')));
    expect(registered.connectorTypes.length).toBeGreaterThan(30);
    expect(registered.connectorTypes).toEqual(
      expect.arrayContaining([
        '.email',
        '.index',
        '.cases',
        '.workflows',
        '.observability-ai-assistant',
      ])
    );
  });

  it('come from a contribution of every plugin that registers connector types or adapters', () => {
    const registering = git(
      `grep -lE "(actions|actionsSetup|actionsPlugin)\\??\\.(registerType|registerSubActionConnectorType)\\(|registerSubActionConnectorType\\(|\\.registerConnectorAdapter\\(" -- 'x-pack/**/server/**/*.ts' 'src/**/server/**/*.ts'`
    )
      .split('\n')
      .filter(Boolean)
      // Tests, their plugins and examples register connector types of their own.
      .filter((file) => !/\.test\.ts$|\/test\/|\/examples\/|mock/.test(file));

    const contributing = new Set(getContributionFiles().map(({ plugin }) => plugin));
    const pluginOf = (file: string) => {
      let dir = dirname(file);
      while (dir !== '.' && !git(`ls-files '${dir}/kibana.jsonc'`).trim()) dir = dirname(dir);
      return dir;
    };
    const withoutContribution = [...new Set(registering.map(pluginOf))].filter(
      (plugin) => !contributing.has(plugin)
    );
    expect(withoutContribution).toEqual([]);
  });
});
