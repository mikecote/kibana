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
import { join, resolve } from 'path';
import { REPO_ROOT } from '@kbn/repo-info';
import type { Metafile } from 'esbuild';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getTaskBundleEntries, buildTaskBundle, getStartupOutputs } = require(join(
  REPO_ROOT,
  'src/dev/task_bundles/build'
));

/**
 * Startup imports must contain the task runtime without web plugins or connector executors.
 * Deferred chunks retain the implementations needed by tasks that execute those capabilities.
 */
describe('the .es-query bundle', () => {
  jest.setTimeout(300000);

  it.each(['stackAlerts__es_query', 'securitySolution__query'])(
    '%s starts without UI, plugin classes, or connector executor SDKs',
    async (name) => {
      const entry = getTaskBundleEntries().find(
        (candidate: { name: string }) => candidate.name === name
      );
      const built = await buildTaskBundle({
        entry,
        outDir: mkdtempSync(join(tmpdir(), 'task-bundle-hygiene-')),
        sourcemap: false,
        metafile: true,
      });
      const metafile = built.metafile as Metafile;
      const outputs = new Map(
        Object.entries(metafile.outputs).map(([file, output]) => [resolve(REPO_ROOT, file), output])
      );
      const startupOutputs: string[] = getStartupOutputs(metafile, built.outfile);
      const inOutput = startupOutputs
        .flatMap((file) => {
          const output = outputs.get(file);
          if (!output) throw new Error(`Missing output metadata for ${file}`);
          return Object.entries(output.inputs);
        })
        .filter(([, { bytesInOutput }]) => bytesInOutput > 0)
        .map(([input]) => input);
      expect(inOutput).toContain('src/core/packages/root/server-internal/src/task_root.ts');

      const pluginClasses = inOutput.filter((input) =>
        /\/plugins\/(?:(?:shared|private)\/)?[^/]+\/server\/plugin\.ts$/.test(input)
      );
      expect(pluginClasses).toEqual([]);
      expect(inOutput.filter((input) => input.includes('/public/'))).toEqual([]);
      expect(inOutput.filter((input) => input.includes('node_modules/@elastic/eui/'))).toEqual([]);
      expect(
        inOutput.filter((input) =>
          /node_modules\/(mongodb|mysql2|mssql|tedious|openai|gpt-tokenizer|@aws-sdk|@azure|@google-cloud)\//.test(
            input
          )
        )
      ).toEqual([]);
      expect(
        inOutput.filter((input) => input.includes('node_modules/@elastic/opamp-client-node/'))
      ).toEqual([]);

      // Count deferred chunks too, separately from the startup dependency checks above.
      expect(built.bytes).toBeLessThan(
        (name === 'securitySolution__query' ? 40 : 35) * 1024 * 1024
      );
    }
  );
});
