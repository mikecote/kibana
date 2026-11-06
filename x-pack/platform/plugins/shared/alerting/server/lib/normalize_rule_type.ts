/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { i18n } from '@kbn/i18n';
import { intersection } from 'lodash';
import type { Logger } from '@kbn/core/server';
import { TaskCost } from '@kbn/task-manager-plugin/server/task';
import type { RecoveredActionGroupId, RuleAlertData } from '../../common';
import { RecoveredActionGroup, getBuiltinActionGroups } from '../../common';
import type { AlertingConfig } from '../config';
import { getRuleTypeIdValidLegacyConsumers } from '../rule_type_registry_deprecated_consumers';
import type { NormalizedRuleType, UntypedNormalizedRuleType } from '../rule_type_registry';
import { getRuleTaskTimeout } from './get_rule_task_timeout';
import type {
  AlertInstanceContext,
  AlertInstanceState,
  RuleType,
  RuleTypeParams,
  UntypedRuleType,
  RuleTypeState,
} from '../types';

export const RULE_TYPES_WITH_CUSTOM_COST: Record<string, TaskCost> = {
  'siem.indicatorRule': TaskCost.ExtraLarge,
};
/**
 * What the framework sets on a rule type when it is registered, whatever the plugin that owns it
 * wrote: its task timeout, and the defaults for recovery and for cancelling alerts on a timeout.
 * Mutates the rule type, as `registerType` always has.
 */
export function applyRuleTypeDefaults<
  T extends Pick<
    UntypedRuleType,
    | 'id'
    | 'ruleTaskTimeout'
    | 'doesSetRecoveryContext'
    | 'autoRecoverAlerts'
    | 'cancelAlertsOnRuleTimeout'
  >
>(ruleType: T, { config, logger }: { config: AlertingConfig; logger: Logger }): T {
  ruleType.ruleTaskTimeout = getRuleTaskTimeout({
    config: config.rules,
    ruleTaskTimeout: ruleType.ruleTaskTimeout,
    ruleTypeId: ruleType.id,
  });
  ruleType.doesSetRecoveryContext = ruleType.doesSetRecoveryContext ?? false;
  ruleType.autoRecoverAlerts = ruleType.autoRecoverAlerts ?? true;

  if (ruleType.autoRecoverAlerts === true && config.cancelAlertsOnRuleTimeout === false) {
    logger.debug(
      `Setting xpack.alerting.cancelAlertsOnRuleTimeout=false is incompatible with rule type "${ruleType.id}" and will be ignored.`
    );
    ruleType.cancelAlertsOnRuleTimeout = true;
  } else {
    ruleType.cancelAlertsOnRuleTimeout =
      ruleType.cancelAlertsOnRuleTimeout ?? config.cancelAlertsOnRuleTimeout;
  }
  return ruleType;
}

/**
 * The rule type exactly as `RuleTypeRegistry.register` keeps it, built from what the plugin that
 * owns the rule type wrote. A task type module builds it in a task process the same way Kibana does,
 * so both run the same rule type for the same config.
 */
export function normalizeRuleType(
  ruleType: UntypedRuleType,
  { config, logger }: { config: AlertingConfig; logger: Logger }
): UntypedNormalizedRuleType {
  applyRuleTypeDefaults(ruleType, { config, logger });
  ruleType.actionVariables = normalizedActionVariables(ruleType.actionVariables);
  return augmentActionGroupsWithReserved(ruleType, config) as unknown as UntypedNormalizedRuleType;
}

export function normalizedActionVariables(actionVariables: RuleType['actionVariables']) {
  return {
    context: actionVariables?.context ?? [],
    state: actionVariables?.state ?? [],
    params: actionVariables?.params ?? [],
  };
}

export function augmentActionGroupsWithReserved<
  Params extends RuleTypeParams,
  ExtractedParams extends RuleTypeParams,
  State extends RuleTypeState,
  InstanceState extends AlertInstanceState,
  InstanceContext extends AlertInstanceContext,
  ActionGroupIds extends string,
  RecoveryActionGroupId extends string,
  AlertData extends RuleAlertData
>(
  ruleType: RuleType<
    Params,
    ExtractedParams,
    State,
    InstanceState,
    InstanceContext,
    ActionGroupIds,
    RecoveryActionGroupId,
    AlertData
  >,
  config: AlertingConfig
): NormalizedRuleType<
  Params,
  ExtractedParams,
  State,
  InstanceState,
  InstanceContext,
  ActionGroupIds,
  RecoveredActionGroupId | RecoveryActionGroupId,
  AlertData
> {
  const reservedActionGroups = getBuiltinActionGroups(ruleType.recoveryActionGroup);
  const { id, actionGroups, recoveryActionGroup } = ruleType;

  const activeActionGroups = new Set<string>(actionGroups.map((item) => item.id));
  const intersectingReservedActionGroups = intersection<string>(
    [...activeActionGroups.values()],
    reservedActionGroups.map((item) => item.id)
  );
  if (recoveryActionGroup && activeActionGroups.has(recoveryActionGroup.id)) {
    throw new Error(
      i18n.translate(
        'xpack.alerting.ruleTypeRegistry.register.customRecoveryActionGroupUsageError',
        {
          defaultMessage:
            'Rule type [id="{id}"] cannot be registered. Action group [{actionGroup}] cannot be used as both a recovery and an active action group.',
          values: {
            actionGroup: recoveryActionGroup.id,
            id,
          },
        }
      )
    );
  } else if (intersectingReservedActionGroups.length > 0) {
    throw new Error(
      i18n.translate('xpack.alerting.ruleTypeRegistry.register.reservedActionGroupUsageError', {
        defaultMessage:
          'Rule type [id="{id}"] cannot be registered. Action groups [{actionGroups}] are reserved by the framework.',
        values: {
          actionGroups: intersectingReservedActionGroups.join(', '),
          id,
        },
      })
    );
  }

  const activeActionGroupSeverities = new Set<number>();
  actionGroups.forEach((actionGroup) => {
    if (actionGroup.severity) {
      if (activeActionGroupSeverities.has(actionGroup.severity.level)) {
        throw new Error(
          i18n.translate(
            'xpack.alerting.ruleTypeRegistry.register.duplicateActionGroupSeverityError',
            {
              defaultMessage:
                'Rule type [id="{id}"] cannot be registered. Action group definitions cannot contain duplicate severity levels.',
              values: {
                id,
              },
            }
          )
        );
      }
      activeActionGroupSeverities.add(actionGroup.severity.level);
    }
  });

  return {
    ...ruleType,
    ...(config?.rules?.overwriteProducer ? { producer: config.rules.overwriteProducer } : {}),
    actionGroups: [...actionGroups, ...reservedActionGroups],
    recoveryActionGroup: recoveryActionGroup ?? RecoveredActionGroup,
    validLegacyConsumers: getRuleTypeIdValidLegacyConsumers(id),
  };
}
