/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

import path from 'path';

export default async function ({ readConfigFile }) {
  const integrationConfig = await readConfigFile(require.resolve('../api_integration/config'));

  return {
    testFiles: [
      require.resolve('./tests'),
    ],
    services: {
      ...integrationConfig.get('services'),
    },
    pageObjects: integrationConfig.get('pageObjects'),
    servers: {
      ...integrationConfig.get('servers'),
      elasticsearch: {
        ...integrationConfig.get('servers').elasticsearch,
        protocol: 'https',
      },
    },
    esTestCluster: {
      ...integrationConfig.get('esTestCluster'),
      serverArgs: [
        ...integrationConfig.get('esTestCluster').serverArgs,
        'xpack.security.enabled=true',
        'xpack.security.http.ssl.enabled=true',
        `xpack.security.http.ssl.key=${path.resolve(__dirname, 'fixtures/certs/elasticsearch/elasticsearch.key')}`,
        `xpack.security.http.ssl.certificate=${path.resolve(__dirname, 'fixtures/certs/elasticsearch/elasticsearch.crt')}`,
        `xpack.security.http.ssl.certificate_authorities=${path.resolve(__dirname, 'fixtures/certs/ca/ca.crt')}`,
      ]
    },
    apps: integrationConfig.get('apps'),
    esArchiver: {
      directory: path.resolve(__dirname, '../functional/es_archives')
    },
    screenshots: integrationConfig.get('screenshots'),
    junit: {
      reportName: 'Plugin Functional Tests',
    },
    kbnTestServer: {
      ...integrationConfig.get('kbnTestServer'),
      serverArgs: [
        '--elasticsearch.hosts=https://localhost:9220',
        `--elasticsearch.ssl.certificateAuthorities=${path.resolve(__dirname, 'fixtures/certs/ca/ca.crt')}`,
        '--elasticsearch.username=kibana',
        '--elasticsearch.password=changeme',
      ],
    },
  };
}
