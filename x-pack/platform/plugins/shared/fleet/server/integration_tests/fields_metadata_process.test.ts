/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import JSZip from 'jszip';
import { generateKey, readKey, readPrivateKey, createMessage, sign } from 'openpgp';
import { stringify } from 'yaml';
import { coreMock } from '@kbn/core/server/mocks';
import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import type { KibanaFeatureConfig } from '@kbn/features-plugin/common';
import { EMPTY } from 'rxjs';
import { auditServiceMock } from '@kbn/security-plugin/server/audit/mocks';
import { SecurityLicenseService } from '@kbn/security-plugin/common/licensing/license_service';
import type { SecurityTaskPluginStart } from '@kbn/security-plugin/server/task_plugin';
import { ConfigSchema as spacesConfigSchema } from '@kbn/spaces-plugin/server/config';
import {
  startWorkflowProcessHarness,
  WORKFLOW_PROCESS_TEST_MODES,
} from '@kbn/workflows-execution-engine/server/integration_tests/workflow_process_harness';

import type { FleetConfigType } from '../../common/types';
import { parseExperimentalConfigValue } from '../../common/experimental_features';
import { appContextService } from '../services/app_context';
import { getFleetPackageMetadataTaskProcessSettings } from '../services/run_time/package_metadata_settings';
import { _purgeBundledPackagesCache } from '../services/epm/packages/bundled_packages';
import { contribution } from '../task_types/workflow_services_contribution';
import { getSavedObjectTypes } from '../saved_objects';

const features: KibanaFeatureConfig[] = ['fleet', 'fleetv2'].map((id) => ({
  id,
  name: id,
  category: { id: 'management', label: 'Management' },
  app: [id],
  privileges: {
    all: { app: [id], savedObject: { all: [], read: [] }, ui: ['read'] },
    read: { app: [id], savedObject: { all: [], read: [] }, ui: ['read'] },
  },
}));

const createSigningMaterial = () =>
  generateKey({
    type: 'ecc',
    curve: 'curve25519',
    userIDs: [{ name: 'Native Fleet worker test' }],
    format: 'armored',
  });
let signingMaterial: Awaited<ReturnType<typeof createSigningMaterial>>;
beforeAll(async () => {
  signingMaterial = await createSigningMaterial();
});

describe.each(WORKFLOW_PROCESS_TEST_MODES)(
  'Native Fleet metadata in $mode (reuse: $reuse)',
  ({ mode, reuse }) => {
    let harness: Awaited<ReturnType<typeof startWorkflowProcessHarness>>;
    let limitedKey: string;
    let archiveSha256: string;
    let keyId: string;
    const requests: string[] = [];
    const registry = createServer();
    beforeAll(async () => {
      const zip = new JSZip();
      zip.file(
        'fixture-1.0.0/manifest.yml',
        stringify({
          format_version: '3.0.0',
          name: 'fixture',
          version: '1.0.0',
          title: 'Owned fixture',
          description: 'Task process integration metadata',
          type: 'integration',
          owner: { github: 'elastic/fleet', type: 'elastic' },
          categories: ['custom'],
          policy_templates: [],
        })
      );
      zip.file(
        'fixture-1.0.0/data_stream/logs/manifest.yml',
        stringify({ title: 'Fixture logs', type: 'logs', dataset: 'fixture.logs', streams: [] })
      );
      zip.file(
        'fixture-1.0.0/data_stream/logs/fields/fields.yml',
        stringify([
          {
            name: 'fixture.logs.marker',
            type: 'keyword',
            description: 'Worker-owned integration field',
          },
        ])
      );
      const archive = await zip.generateAsync({ type: 'nodebuffer' });
      archiveSha256 = createHash('sha256').update(archive).digest('hex');
      const { publicKey, privateKey } = signingMaterial;
      keyId = (await readKey({ armoredKey: publicKey })).getKeyID().toHex();
      const signature = await sign({
        message: await createMessage({ binary: new Uint8Array(archive) }),
        signingKeys: await readPrivateKey({ armoredKey: privateKey }),
        detached: true,
        format: 'armored',
      });
      const entry = {
        name: 'fixture',
        version: '1.0.0',
        title: 'Owned fixture',
        type: 'integration',
        categories: ['custom'],
        download: '/epr/fixture/fixture-1.0.0.zip',
        signature_path: '/epr/fixture/fixture-1.0.0.zip.sig',
        path: '/package/fixture/1.0.0',
      };
      registry.on('request', (request, response) => {
        const path = request.url ?? '/';
        requests.push(path);
        if (path.startsWith('/search')) {
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify([entry]));
        } else if (path === entry.path || path === `${entry.path}/`) {
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify(entry));
        } else if (path === entry.download) {
          response.setHeader('Content-Type', 'application/zip');
          response.end(archive);
        } else if (path === entry.signature_path) {
          response.end(signature);
        } else {
          response.statusCode = 404;
          response.end();
        }
      });
      await new Promise<void>((resolve) => registry.listen(0, '127.0.0.1', resolve));
      const address = registry.address();
      if (!address || typeof address === 'string') throw new Error('Registry has no address');
      const directory = await mkdtemp(join(tmpdir(), 'fleet-worker-metadata-'));
      let metadata: Awaited<ReturnType<typeof getFleetPackageMetadataTaskProcessSettings>>;
      try {
        const bundles = join(directory, 'bundles');
        const signingKey = join(directory, 'key');
        await mkdir(bundles);
        await writeFile(join(bundles, 'fixture-1.0.0.zip'), archive);
        await writeFile(signingKey, publicKey);
        const config: FleetConfigType = {
          enabled: true,
          agents: { enabled: true, elasticsearch: {} },
          registryUrl: `http://127.0.0.1:${address.port}`,
          developer: { bundledPackageLocation: bundles },
          packageVerification: { gpgKeyPath: signingKey },
        };
        const core = coreMock.createStart();
        appContextService.startExecution({
          elasticsearch: core.elasticsearch.client,
          savedObjects: core.savedObjects,
          securitySetup: {
            audit: auditServiceMock.create(),
            license: new SecurityLicenseService().setup({ license$: EMPTY }).license,
          },
          registry: { kind: 'native' },
          configInitialValue: config,
          experimentalFeatures: parseExperimentalConfigValue([], {}),
          logger: loggingSystemMock.createLogger(),
          kibanaVersion: '9.9.9',
          kibanaBranch: 'main',
          kibanaInstanceId: 'fixture',
          isProductionMode: false,
          isFipsEnabled: false,
        });
        _purgeBundledPackagesCache();
        metadata = await getFleetPackageMetadataTaskProcessSettings();
      } finally {
        appContextService.stop();
        _purgeBundledPackagesCache();
        await rm(directory, { recursive: true, force: true });
      }
      harness = await startWorkflowProcessHarness({
        mode,
        reuse,
        additionalContributions: {
          'workflow-steps': [join(__dirname, 'fixtures/fields_metadata_contribution.ts')],
        },
        savedObjectTypes: Object.values(
          getSavedObjectTypes({
            useSpaceAwareness: parseExperimentalConfigValue(
              metadata.config.enableExperimental ?? [],
              metadata.config.experimentalFeatures ?? {}
            ).useSpaceAwareness,
          })
        ),
        seedContributions: { 'workflow-steps': [contribution] },
        settings: {
          fieldsMetadataRuntime: {
            integrationFieldsExtractor: 'fleet',
            integrationListExtractor: 'fleet',
          },
          fleetPackageMetadata: metadata,
          spacesRuntime: {
            config: spacesConfigSchema.validate({}, { offering: 'traditional' }),
            buildFlavor: 'traditional',
            features,
            cpsEnabled: false,
          },
        },
        workflows: {
          metadata: { steps: [{ name: 'metadata', type: 'test.fleet.metadata', with: {} }] },
        },
        seed: async ({ es, host }) => {
          const security = host.plugins?.security as SecurityTaskPluginStart | undefined;
          if (!security) throw new Error('The capability fixture requires native Security');
          const { actions } = security.authz;
          await es.security.putPrivileges({
            body: {
              'kibana-.kibana': {
                metadata_reader: {
                  application: 'kibana-.kibana',
                  name: 'metadata_reader',
                  actions: [actions.login, actions.ui.get('fleet', 'read')],
                },
              },
            },
          });
          const key = await es.security.createApiKey({
            name: 'metadata-reader',
            role_descriptors: {
              reader: {
                cluster: [],
                indices: [{ names: ['*'], privileges: ['all'], allow_restricted_indices: true }],
                applications: [
                  {
                    application: 'kibana-.kibana',
                    privileges: ['metadata_reader'],
                    resources: ['*'],
                  },
                ],
              },
            },
          });
          limitedKey = key.encoded;
        },
      });
    }, 240000);
    afterAll(async () => {
      await harness?.stop();
      if (!registry.listening) return;
      registry.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        registry.close((error) => (error ? reject(error) : resolve()))
      );
    });
    it('loads native integration fields and portable material while rechecking identity and space gates', async () => {
      const onDispatchFailure = jest.fn();
      const seen = new Set<string>();
      const run = async (apiKey: string, allowed: boolean) => {
        const before = requests.length;
        await harness.run('metadata', onDispatchFailure, { apiKey });
        const executions = await harness.executionsOf('metadata');
        const execution = executions.find(({ id }) => !seen.has(id));
        if (!execution) throw new Error('No metadata execution was persisted');
        seen.add(execution.id);
        expect({ status: execution.status, error: execution.error }).toEqual({
          status: 'completed',
          error: undefined,
        });
        const [step] = await harness.stepsOf(execution.id);
        expect(step.output.output ?? step.output).toEqual({
          source: allowed ? 'integration' : null,
          description: allowed ? 'Worker-owned integration field' : null,
          archiveSha256,
          keyId,
          verificationStatus: allowed ? 'verified' : null,
        });
        if (!allowed) expect(requests.length).toBe(before);
      };
      await run(harness.apiKey, true);
      await run(limitedKey, false);
      await run(harness.apiKey, true);
      await harness.es.update({
        index: '.kibana',
        id: 'space:default',
        refresh: 'wait_for',
        doc: { space: { disabledFeatures: ['fleet'] } },
      });
      await run(harness.apiKey, false);
      await harness.es.update({
        index: '.kibana',
        id: 'space:default',
        refresh: 'wait_for',
        doc: { space: { disabledFeatures: [] } },
      });
      await run(harness.apiKey, true);
      expect(requests.some((path) => path.startsWith('/search'))).toBe(true);
      expect(harness.getWorkerStats().spawned).toBe(reuse ? 1 : 5);
      expect(harness.kibanaRequests).toEqual([]);
      expect(onDispatchFailure).not.toHaveBeenCalled();
    }, 240000);
  }
);
