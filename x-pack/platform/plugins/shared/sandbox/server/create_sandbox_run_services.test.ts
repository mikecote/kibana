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
import { loggerMock } from '@kbn/logging-mocks';
import { brandSpaceId } from '@kbn/core-spaces-common';
import { httpServerMock } from '@kbn/core/server/mocks';
import { config } from './config';
import { readTlsCredentials } from './tls_credentials';
import { createSandboxRunServices } from './create_sandbox_run_services';
import {
  getSandboxTaskProcessSettings,
  restoreSandboxTlsCredentials,
} from './task_process_settings';
import type { SandboxTaskProcessSettings } from './task_process_settings';

const identity = (buffer: Buffer): Buffer => buffer;
const readCertificate = (name: string): Buffer =>
  readFileSync(join(REPO_ROOT, 'src/platform/packages/shared/kbn-dev-utils/certs', name));

it('uses native gRPC sessions with portable mTLS credentials, API-key auth and isolated space identities', async () => {
  const server = new grpc.Server();
  const requests: Array<{
    authorization: grpc.MetadataValue[];
    conversation: grpc.MetadataValue[];
    paths: string;
  }> = [];
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
          paths: call.request.toString('utf8'),
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
        [{ private_key: readCertificate('kibana.key'), cert_chain: readCertificate('kibana.crt') }],
        true
      ),
      (error, bound) => (error ? reject(error) : resolve(bound))
    )
  );
  const directory = createPrivateTemporaryDirectory('sandbox-main-tls-');
  const pluginConfig = config.schema.validate({
    enabled: true,
    host: 'localhost',
    port,
    api_key: 'native-sandbox-key',
    ssl: {
      certificate_authorities: directory.writeFile('ca.crt', readCertificate('ca.crt')),
      certificate: directory.writeFile('client.crt', readCertificate('relay.crt')),
      key: directory.writeFile('client.key', readCertificate('relay.key')),
    },
  });
  const tlsCredentials = readTlsCredentials(pluginConfig.ssl);
  const snapshot = JSON.parse(
    JSON.stringify(getSandboxTaskProcessSettings(pluginConfig, tlsCredentials, true))
  ) as SandboxTaskProcessSettings;
  directory.cleanup();
  const logger = loggerMock.create();
  const main = createSandboxRunServices({ config: pluginConfig, tlsCredentials, logger });
  const worker = createSandboxRunServices({
    config: snapshot.config,
    tlsCredentials: restoreSandboxTlsCredentials(snapshot.tlsCredentials),
    spaces: { getSpaceId: () => brandSpaceId('operations') },
    logger,
  });
  try {
    const mainSession = main.sandbox.getSessionForSpace('default', 'conversation');
    const workerSession = worker.sandbox.getSessionForSpace('operations', 'conversation');
    expect(worker.sandbox.getSession(httpServerMock.createKibanaRequest(), 'conversation')).toBe(
      workerSession
    );
    expect(worker.sandbox.getSessionForSpace('operations', 'conversation')).toBe(workerSession);
    expect(worker.sandbox.getSessionForSpace('default', 'conversation')).not.toBe(workerSession);
    for (const session of [mainSession, workerSession]) {
      expect(await session.statFiles(['/workspace'])).toEqual([
        { path: '/workspace', size: 0, is_dir: true, exists: true, modified_time_sec: 0 },
      ]);
    }
    expect(requests.map(({ conversation }) => conversation)).toEqual([
      ['default__conversation'],
      ['operations__conversation'],
    ]);
    for (const request of requests) {
      expect(request.authorization).toEqual(['ApiKey native-sandbox-key']);
      expect(request.paths).toContain('/workspace');
    }
    expect(JSON.stringify(snapshot)).not.toContain('sandbox-main-tls-');
  } finally {
    main.stop();
    worker.stop();
    await new Promise<void>((resolve, reject) =>
      server.tryShutdown((error) => (error ? reject(error) : resolve()))
    );
  }
});

it('preserves Main behavior when Sandbox is disabled and rejects incomplete enabled snapshots', () => {
  const logger = loggerMock.create();
  const disabled = createSandboxRunServices({
    config: { enabled: false, host: 'localhost', port: 9090 },
    logger,
  });
  expect(() => disabled.sandbox.getSessionForSpace('default', 'conversation')).toThrow(
    'Sandbox is not configured in this deployment: xpack.sandbox.enabled is false'
  );
  expect(() =>
    createSandboxRunServices({
      config: { enabled: true, api_key: 'native-key', host: 'localhost', port: 9090 },
      logger,
    })
  ).toThrow('Native Sandbox requires the TLS credential snapshot used by Main');
  disabled.stop();
});
