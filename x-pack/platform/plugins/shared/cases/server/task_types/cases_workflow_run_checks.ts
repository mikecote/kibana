/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { WorkflowStepRunCheck } from '@kbn/workflows-extensions/server';
import { AssignCaseStepTypeId } from '../../common/workflows/steps/assign_case';
import { CloseCaseStepTypeId } from '../../common/workflows/steps/close_case';
import { CreateCaseStepTypeId } from '../../common/workflows/steps/create_case';
import { CreateCaseFromTemplateStepTypeId } from '../../common/workflows/steps/create_case_from_template';
import { SetStatusStepTypeId } from '../../common/workflows/steps/set_status';
import { UpdateCaseStepTypeId } from '../../common/workflows/steps/update_case';
import { UpdateCasesStepTypeId } from '../../common/workflows/steps/update_cases';
import { KIBANA_ONLY_CASES_STEPS } from '../workflows/kibana_only_steps';
import type { CasesWorkflowsProcessSettings } from './cases_task_process_settings';

/** Whether the step as written names one of the fields (a template expression may produce it). */
const mentions = (config: Record<string, unknown>, fields: string[]) => {
  const written = JSON.stringify(config ?? {});
  return fields.some((field) => written.includes(field));
};

const UPDATE_STEPS = new Set([UpdateCaseStepTypeId, UpdateCasesStepTypeId]);

/**
 * The steps that a task process does not serve (`KIBANA_ONLY_CASES_STEPS`: they are not registered,
 * and a `cases.*` step type missing from the registry would be taken for a sub action of the
 * `.cases` connector, so the check declines them by name) and the steps that it serves differently
 * from Kibana depending on what Kibana has registered or configured, which a process cannot
 * rebuild. The run is declined (Kibana runs it) before it has side effects.
 *
 * - Changing the status of a case syncs the status of its alerts, and Kibana reports the alerts
 *   that changed to the plugins that listen on the cases event bus (the security solution turns them
 *   into its `alert status changed` workflow triggers): declined when a plugin listens.
 * - Setting a close reason validates it with the validator that the owner's plugin registered:
 *   declined when any plugin registered one.
 * - Assigning users sends them an email with the notifications plugin: declined when Kibana can
 *   send emails (the process has no email service).
 */
export const createCasesWorkflowRunCheck =
  ({
    hasAlertStatusChangedListeners,
    closeReasonOwners,
    isEmailServiceAvailable,
  }: Pick<
    CasesWorkflowsProcessSettings,
    'hasAlertStatusChangedListeners' | 'closeReasonOwners' | 'isEmailServiceAvailable'
  >): WorkflowStepRunCheck =>
  ({ type, config }) => {
    if (type in KIBANA_ONLY_CASES_STEPS) {
      return KIBANA_ONLY_CASES_STEPS[type];
    }

    if (hasAlertStatusChangedListeners) {
      const changesStatus =
        type === SetStatusStepTypeId ||
        type === CloseCaseStepTypeId ||
        (UPDATE_STEPS.has(type) && mentions(config, ['status', 'syncAlerts']));
      if (changesStatus) {
        return 'changing the status of a case syncs its alerts, and the alert status changes are forwarded to the plugins that listen to the cases event bus, which a task process does not have';
      }
    }

    if (closeReasonOwners.length > 0 && UPDATE_STEPS.has(type)) {
      if (mentions(config, ['closeReason', 'close_reason'])) {
        return `a close reason is validated by the validators that plugins register (${closeReasonOwners.join(
          ', '
        )}), which a task process does not have`;
      }
    }

    if (isEmailServiceAvailable) {
      const mayAssign =
        type === AssignCaseStepTypeId ||
        type === CreateCaseFromTemplateStepTypeId ||
        ((type === CreateCaseStepTypeId || UPDATE_STEPS.has(type)) &&
          mentions(config, ['assignees']));
      if (mayAssign) {
        return 'assigning users to a case emails them with the notifications plugin, which a task process does not have';
      }
    }

    return undefined;
  };
