/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { createRuleTaskType } from '@kbn/alerting-plugin/server/task_types/rule_task_type';
import { ML_ALERT_TYPES } from '../../common/constants/alerts';
import { getJobsMonitoringRuleType } from '../lib/alerts/register_jobs_monitoring_rule_type';
import {
  createMlTaskProcessServices,
  getMlTaskProcessSavedObjectTypes,
} from './ml_task_process_services';

/** The anomaly detection jobs health rule type, which a task process can run. */
export const taskType = createRuleTaskType(
  {
    ruleTypeId: ML_ALERT_TYPES.AD_JOBS_HEALTH,
    getRuleType: (deps) => {
      const ml = createMlTaskProcessServices(deps);
      return ml.withLicense(
        getJobsMonitoringRuleType({
          mlServicesProviders: ml.internalServicesProviders,
          logger: deps.logger,
        })
      ) as never;
    },
  },
  { savedObjectTypes: getMlTaskProcessSavedObjectTypes() }
);
