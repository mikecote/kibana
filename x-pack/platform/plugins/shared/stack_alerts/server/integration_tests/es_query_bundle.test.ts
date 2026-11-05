/**
 * @jest-environment node
 */

/* eslint-disable @kbn/eslint/require-license-header */
/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { REPO_ROOT } from '@kbn/repo-info';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getTaskBundleEntries, buildTaskBundle } = require(join(
  REPO_ROOT,
  'src/dev/task_bundles/build'
));

/**
 * A bundle must hold what the task needs and not the plugins around it. The one plugin it does hold
 * is the encrypted saved objects plugin, which a task process runs as Kibana does. Plugin classes reach a bundle
 * through a barrel import or a constant that lives next to the class, and they bring everything the
 * class imports; this fails when that happens, and when the bundle grows past its budget.
 */
describe('the .es-query bundle', () => {
  jest.setTimeout(300000);

  it('has no plugin class, and stays within its size budget', async () => {
    const entry = getTaskBundleEntries().find(
      ({ name }: { name: string }) => name === 'stackAlerts__es_query'
    );
    const built = await buildTaskBundle({
      entry,
      outDir: mkdtempSync(join(tmpdir(), 'task-bundle-hygiene-')),
      sourcemap: false,
      metafile: true,
    });
    const inOutput = Object.entries(
      Object.values(
        built.metafile.outputs as Record<
          string,
          { inputs: Record<string, { bytesInOutput: number }> }
        >
      )[0].inputs
    )
      .filter(([, { bytesInOutput }]) => bytesInOutput > 0)
      .map(([input]) => input);

    const pluginClasses = inOutput.filter((input) =>
      /\/plugins\/(shared|private)\/[^/]+\/server\/plugin\.ts$/.test(input)
    );
    expect(pluginClasses).toEqual([
      'x-pack/platform/plugins/shared/encrypted_saved_objects/server/plugin.ts',
    ]);
    expect(inOutput.filter((input) => input.includes('/public/'))).toEqual([]);
    expect(inOutput.filter((input) => input.includes('node_modules/@elastic/eui/'))).toEqual([]);

    // 27 MB when this was written: Core's internals and the connector types are most of it.
    expect(built.bytes).toBeLessThan(35 * 1024 * 1024);
  });
});
