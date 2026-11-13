/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { createRuleTaskType } from '@kbn/alerting-plugin/server/task_types/rule_task_type';
import { ML_ALERT_TYPES } from '../../common/constants/alerts';
import { getAnomalyDetectionAlertRuleType } from '../lib/alerts/register_anomaly_detection_alert_type';
import {
  createMlTaskProcessServices,
  getMlTaskProcessSavedObjectTypes,
  ML_TASK_PROCESS_SETTINGS_ID,
} from './ml_task_process_services';

/** The anomaly detection rule type, which a task process can run. */
export const taskType = createRuleTaskType(
  {
    ruleTypeId: ML_ALERT_TYPES.ANOMALY_DETECTION,
    getRuleType: (deps) => {
      const ml = createMlTaskProcessServices(deps);
      return ml.withLicense(
        getAnomalyDetectionAlertRuleType({ mlSharedServices: ml.sharedServicesProviders })
      ) as never;
    },
  },
  {
    settings: [ML_TASK_PROCESS_SETTINGS_ID],
    savedObjectTypes: getMlTaskProcessSavedObjectTypes(),
  }
);
