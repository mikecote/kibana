/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import * as grpc from '@grpc/grpc-js';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createPrivateTemporaryDirectory } from '@kbn/fs';
import { REPO_ROOT } from '@kbn/repo-info';
import { z } from '@kbn/zod/v4';
import {
  startWorkflowProcessHarness,
  WORKFLOW_PROCESS_TEST_MODES,
} from '@kbn/workflows-execution-engine/server/integration_tests/workflow_process_harness';
import { config } from '../config';
import { readTlsCredentials } from '../tls_credentials';
import {
  getSandboxTaskProcessSettings,
  SANDBOX_TASK_PROCESS_SETTINGS_ID,
} from '../task_process_settings';

const identity = (buffer: Buffer): Buffer => buffer;
const readCertificate = (name: string): Buffer =>
  readFileSync(join(REPO_ROOT, 'src/platform/packages/shared/kbn-dev-utils/certs', name));
const output = z.object({ exists: z.literal(true), same_session: z.literal(true) });

describe.each(WORKFLOW_PROCESS_TEST_MODES)(
  'Native Sandbox gRPC in $mode/$reuse',
  ({ mode, reuse }) => {
    let harness: Awaited<ReturnType<typeof startWorkflowProcessHarness>>;
    let server: grpc.Server;
    const requests: Array<{
      authorization: grpc.MetadataValue[];
      conversation: grpc.MetadataValue[];
    }> = [];
    beforeAll(async () => {
      server = new grpc.Server();
      server.addService(
        {
          statFiles: {
            path: '/sandbox.SandboxService/StatFiles',
            requestStream: false,
            responseStream: false,
            requestSerialize: identity,
            requestDeserialize: identity,
            responseSerialize: identity,
            responseDeserialize: identity,
          },
        },
        {
          statFiles: (
            call: grpc.ServerUnaryCall<Buffer, Buffer>,
            callback: grpc.sendUnaryData<Buffer>
          ) => {
            requests.push({
              authorization: call.metadata.get('authorization'),
              conversation: call.metadata.get('x-conversation-id'),
            });
            callback(null, Buffer.from('0a100a0a2f776f726b737061636518012001', 'hex'));
          },
        }
      );
      const port = await new Promise<number>((resolve, reject) =>
        server.bindAsync(
          '127.0.0.1:0',
          grpc.ServerCredentials.createSsl(
            readCertificate('ca.crt'),
            [
              {
                private_key: readCertificate('kibana.key'),
                cert_chain: readCertificate('kibana.crt'),
              },
            ],
            true
          ),
          (error, bound) => (error ? reject(error) : resolve(bound))
        )
      );
      const directory = createPrivateTemporaryDirectory('sandbox-worker-main-tls-');
      const pluginConfig = config.schema.validate({
        enabled: true,
        host: 'localhost',
        port,
        api_key: 'native-worker-key',
        ssl: {
          certificate_authorities: directory.writeFile('ca.crt', readCertificate('ca.crt')),
          certificate: directory.writeFile('client.crt', readCertificate('relay.crt')),
          key: directory.writeFile('client.key', readCertificate('relay.key')),
        },
      });
      const snapshot = getSandboxTaskProcessSettings(
        pluginConfig,
        readTlsCredentials(pluginConfig.ssl),
        true
      );
      directory.cleanup();
      harness = await startWorkflowProcessHarness({
        mode,
        reuse,
        settings: { [SANDBOX_TASK_PROCESS_SETTINGS_ID]: snapshot },
        additionalContributions: {
          'workflow-steps': [join(__dirname, 'fixtures/native_sandbox_steps_contribution.ts')],
        },
        workflows: {
          sandbox: {
            steps: [
              {
                name: 'stat',
                type: 'test.sandbox.stat',
                with: { conversation_id: 'native-conversation' },
              },
            ],
          },
        },
      });
    });
    afterAll(async () => {
      await harness?.stop();
      if (server)
        await new Promise<void>((resolve, reject) =>
          server.tryShutdown((error) => (error ? reject(error) : resolve()))
        );
    });
    it('uses native worker sessions over mTLS after Main certificate files are removed', async () => {
      const failed = jest.fn();
      await harness.run('sandbox', failed);
      await harness.run('sandbox', failed);
      expect(failed).not.toHaveBeenCalled();
      const executions = await harness.executionsOf('sandbox');
      expect(executions).toHaveLength(2);
      for (const execution of executions) {
        expect(execution.status).toBe('completed');
        const steps = await harness.stepsOf(execution.id);
        expect(steps).toHaveLength(1);
        expect(output.parse(steps[0].output)).toEqual({ exists: true, same_session: true });
      }
      expect(requests).toHaveLength(2);
      for (const request of requests) {
        expect(request.authorization).toEqual(['ApiKey native-worker-key']);
        expect(request.conversation).toEqual(['default__native-conversation']);
      }
      expect(harness.kibanaRequests).toEqual([]);
    });
  }
);
