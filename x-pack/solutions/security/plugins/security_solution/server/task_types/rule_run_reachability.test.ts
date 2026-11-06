/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

const SERVER = join(__dirname, '..');
const DETECTION_ENGINE = join(SERVER, 'lib', 'detection_engine');

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return name === 'integration_tests' || name === '__mocks__' ? [] : sourceFiles(path);
    }
    return /\.ts$/.test(name) && !/\.(test|mock|mocks)\.ts$/.test(name) ? [path] : [];
  });

const code = (file: string) =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');

const filesUsing = (pattern: RegExp, dir = DETECTION_ENGINE) =>
  sourceFiles(dir)
    .filter((file) => pattern.test(code(file)))
    .map((file) => relative(SERVER, file))
    .sort();

/**
 * A rule run in a task process has the real endpoint service only for what a run reads
 * (`isEndpointExceptionsPerPolicyEnabled`) and for scheduling response actions. What authorizes a
 * request is Kibana's, so it throws in a process. These tests keep it unreachable from a run: if a
 * file outside the write paths starts using them, a run would throw where Kibana does not.
 */
describe('what a security rule run reaches of the services a task process does not have', () => {
  it('uses getRulesAuthz and the osquery authorization checker only to authorize rule writes', () => {
    expect(filesUsing(/getRulesAuthz|getOsqueryResponseActionsAuthzChecker/)).toEqual([
      // The route of the bulk actions, which Kibana serves.
      'lib/detection_engine/rule_management/api/rules/bulk_actions/route.ts',
      'lib/detection_engine/rule_types/create_security_rule_type_wrapper.ts',
      'lib/detection_engine/rule_types/types.ts',
      'lib/detection_engine/rule_types/utils/authorize_rule_response_actions.ts',
    ]);
  });

  it('hands them only to `authorize.params`, which the rules client calls and the task runner never does', () => {
    const wrapper = readFileSync(
      join(DETECTION_ENGINE, 'rule_types', 'create_security_rule_type_wrapper.ts'),
      'utf8'
    );
    // Within the wrapper they appear in the props, and in the authorizer built for `authorize.params`.
    const uses = wrapper.split('\n').filter((line) => /getRulesAuthz/.test(line));
    expect(uses.every((line) => /^\s*(getRulesAuthz,|getRulesAuthz: )/.test(line))).toBe(true);
    expect(wrapper).toMatch(/authorize: \{\s*params: createSecurityRuleParamsAuthorizer\(/);

    const alertingTaskRunner = join(
      __dirname,
      '../../../../../../platform/plugins/shared/alerting/server/task_runner'
    );
    const callsAuthorize = sourceFiles(alertingTaskRunner).filter((file) =>
      /authorize\??\.params|authorizeRuleTypeParams/.test(readFileSync(file, 'utf8'))
    );
    expect(callsAuthorize).toEqual([]);
  });

  it('reads the endpoint app context service in a run only for the per-policy exceptions opt-in', () => {
    const wrapper = readFileSync(
      join(DETECTION_ENGINE, 'rule_types', 'create_security_rule_type_wrapper.ts'),
      'utf8'
    );
    const calls = [...wrapper.matchAll(/endpointAppContextService\.(\w+)/g)].map(
      ([, name]) => name
    );
    expect(calls).toEqual(['isEndpointExceptionsPerPolicyEnabled']);

    // Outside the wrapper and the authorizer, only the response actions use it, and in a process they
    // have the real service (`createEndpointResponseActionsRunServices`), not the stand-in.
    expect(filesUsing(/endpointAppContextService/)).toEqual([
      'lib/detection_engine/rule_response_actions/endpoint_response_action.ts',
      'lib/detection_engine/rule_response_actions/osquery_response_action.ts',
      'lib/detection_engine/rule_response_actions/schedule_notification_response_actions.ts',
      'lib/detection_engine/rule_types/create_security_rule_type_wrapper.ts',
      'lib/detection_engine/rule_types/types.ts',
      'lib/detection_engine/rule_types/utils/authorize_rule_response_actions.ts',
    ]);
  });

  it('never reaches, from the response actions of a rule, what the service has only in Kibana', () => {
    // The getters of `EndpointAppContextService` that throw `...KibanaOnlyError` in a process.
    const kibanaOnly =
      /\.(isCpsActive|getScopedSearchClient|getAgentBuilder|getProductFeaturesService|getCloudSetup|getTelemetryConfigProvider|getCasesClient|getRulesClient|getExceptionListsClient|getFleetToHostFilesClient|getFleetFromHostFilesClient)\(/;
    expect(filesUsing(kibanaOnly, join(DETECTION_ENGINE, 'rule_response_actions'))).toEqual([]);

    // The endpoint client reads them for the two things a person asks of it, and a rule never does:
    // `upload` (the file of the request) and `getFileDownload` (a route).
    const client = code(
      join(
        SERVER,
        'endpoint',
        'services',
        'actions',
        'clients',
        'endpoint',
        'endpoint_actions_client.ts'
      )
    );
    expect(client.match(new RegExp(kibanaOnly.source, 'g'))).toHaveLength(3);
    expect(client).toMatch(/async upload\([\s\S]*?getFleetToHostFilesClient/);
    expect(client).toMatch(/async getFileDownload\([\s\S]*?getFleetFromHostFilesClient/);
    // The commands a rule schedules are these, none of which uploads or downloads a file.
    expect(
      code(join(DETECTION_ENGINE, 'rule_response_actions', 'endpoint_response_action.ts'))
    ).not.toMatch(/\.upload\(|getFileDownload/);
  });
});
