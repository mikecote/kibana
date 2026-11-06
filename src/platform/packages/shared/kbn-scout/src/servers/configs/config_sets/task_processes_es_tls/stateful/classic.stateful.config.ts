/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { readFileSync } from 'fs';
import { CA_CERT_PATH } from '@kbn/dev-utils';
import type { ScoutServerConfig } from '../../../../../types';
import { createTaskProcessesServers } from '../../task_processes/shared';

/**
 * The `task_processes` config set with Elasticsearch over TLS, which Kibana reaches as
 * `kibana_system` with the CA of the cluster. A task process gets that connection over the fork
 * channel, with the certificates written to private files.
 */
const base = createTaskProcessesServers([
  `--elasticsearch.ssl.certificateAuthorities=${CA_CERT_PATH}`,
]);

export const servers: ScoutServerConfig = {
  ...base,
  servers: {
    ...base.servers,
    elasticsearch: {
      ...base.servers.elasticsearch,
      protocol: 'https',
      certificateAuthorities: [readFileSync(CA_CERT_PATH)],
    },
  },
  esTestCluster: { ...base.esTestCluster, ssl: true },
  kbnTestServer: {
    ...base.kbnTestServer,
    serverArgs: base.kbnTestServer.serverArgs.map((arg) =>
      arg.startsWith('--elasticsearch.hosts=') ? arg.replace('http://', 'https://') : arg
    ),
  },
};
