/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { ML_RULE_TYPE_ID } from '@kbn/securitysolution-rules';
import {
  createMlTaskProcessServices,
  getMlTaskProcessSavedObjectTypes,
  ML_TASK_PROCESS_SETTINGS_ID,
} from '@kbn/ml-plugin/server/task_types/ml_task_process_services';
import { createMlAlertType } from '../lib/detection_engine/rule_types';
import { createSecurityRuleTaskType } from './security_rule_task_type';

/** The `ML_RULE_TYPE_ID` detection rule type, which a task process can run. */
export const taskType = createSecurityRuleTaskType(
  ML_RULE_TYPE_ID,
  (wrap, deps) => {
    // The ML services of the process, which first wait for the license the way Kibana's do.
    const ml = createMlTaskProcessServices(deps);
    return ml.withLicense(wrap(createMlAlertType(ml.sharedServicesProviders)) as never);
  },
  {
    settings: [ML_TASK_PROCESS_SETTINGS_ID],
    savedObjectTypes: getMlTaskProcessSavedObjectTypes(),
  }
);
