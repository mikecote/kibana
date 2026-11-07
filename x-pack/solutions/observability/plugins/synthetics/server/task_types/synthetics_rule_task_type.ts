/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { createRuleTaskType } from '@kbn/alerting-plugin/server/task_types/rule_task_type';
import type { AlertingServerSetup } from '@kbn/alerting-plugin/server';
import { getRuleTypeFromRegistration } from '@kbn/alerting-plugin/server/task_types/capture_rule_type';
import type { ObservabilityConfig } from '@kbn/observability-plugin/server';
import type {
  SyntheticsRuleMonitorClient,
  SyntheticsRulePlugins,
  SyntheticsRuleServer,
  SyntheticsTaskProcessSettings,
} from '../alert_rules/rule_dependencies';
import { getSyntheticsRuleSavedObjectTypes } from '../saved_objects/saved_objects';
import { LEGACY_SYNTHETICS_MONITOR_ENCRYPTED_TYPE_SINGLE } from '../saved_objects/synthetics_monitor/legacy_synthetics_monitor';
import { SYNTHETICS_MONITOR_ENCRYPTED_TYPE } from '../saved_objects/synthetics_monitor/synthetics_monitor_config';

type RegisterSyntheticsRule = (
  server: SyntheticsRuleServer,
  plugins: SyntheticsRulePlugins,
  syntheticsMonitorClient: SyntheticsRuleMonitorClient
) => void;

const kibanaOnly = (what: string) => () => {
  throw new Error(`${what} is only available in Kibana`);
};

/**
 * The task type of one of the synthetics rule types. They have no factory of their own: the plugin
 * registers each through a function that takes its server, plugins and monitor client, so this runs
 * that function against a stand-in for the alerting contract that keeps the rule type, with what a
 * task process has of those: the settings Kibana sends, and the host.
 */
export const createSyntheticsRuleTaskType = (
  ruleTypeId: string,
  register: RegisterSyntheticsRule
) =>
  createRuleTaskType(
    {
      ruleTypeId,
      getRuleType: ({ logger, publicBaseUrl, settings, host }) => {
        const { service, isCpsEnabled, serviceManagedLocations } =
          settings.synthetics as SyntheticsTaskProcessSettings;
        const observability = settings.observability as ObservabilityConfig;
        return getRuleTypeFromRegistration((alerting) =>
          register(
            {
              logger,
              basePath: { publicBaseUrl },
              isCpsEnabled,
              config: { service },
              // The rules only read monitors, which are never decrypted, but the client is built with them.
              encryptedSavedObjects: {
                getClient: (options) => host.encryptedSavedObjects!.getClient(options),
              },
            } as SyntheticsRuleServer,
            {
              alerting: alerting as AlertingServerSetup,
              observability: { getAlertDetailsConfig: () => observability.unsafe.alertDetails },
            },
            {
              // The public locations and access status Kibana had when it dispatched the run. Without
              // them (a remote process without them) every location is looked up when a rule filters by one.
              serviceManagedLocations: serviceManagedLocations ?? {
                isAllowed: true,
                locations: [],
                throttling: undefined,
              },
              // Agent policies are Fleet's, which only Kibana has; no rule asks for them.
              privateLocationAPI: {
                getAgentPolicies: kibanaOnly('The list of agent policies'),
              },
            }
          )
        );
      },
    },
    {
      createSavedObjectTypes: getSyntheticsRuleSavedObjectTypes,
      encryptedSavedObjectTypes: [
        LEGACY_SYNTHETICS_MONITOR_ENCRYPTED_TYPE_SINGLE,
        SYNTHETICS_MONITOR_ENCRYPTED_TYPE,
      ],
    }
  );
