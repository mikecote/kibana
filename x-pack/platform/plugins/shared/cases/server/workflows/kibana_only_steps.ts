/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { AddAlertsStepTypeId } from '../../common/workflows/steps/add_alerts';
import { AddAttachmentsStepTypeId } from '../../common/workflows/steps/add_attachments';
import { AddEventsStepTypeId } from '../../common/workflows/steps/add_events';
import { DeleteAttachmentsStepTypeId } from '../../common/workflows/steps/delete_attachments';
import { DeleteCasesStepTypeId } from '../../common/workflows/steps/delete_cases';

/**
 * The cases steps that only Kibana serves, with why. The task process of the workflow task types
 * does not register them, so a workflow that uses one is declined and Kibana runs it.
 *
 * A run check declines them (see `createCasesWorkflowRunCheck`): a step type of the form `cases.*`
 * missing from the registry would otherwise be taken for a sub action of the `.cases` connector.
 */
export const KIBANA_ONLY_CASES_STEPS: Record<string, string> = {
  [AddAttachmentsStepTypeId]:
    'the attachments it adds are validated with the unified attachment types that solutions register in their own setup(), which a task process does not run',
  [AddAlertsStepTypeId]:
    'alert attachments are validated by the alerts client of the rule registry, which needs the alerting authorization and the rule types that other plugins register, and by the unified attachment types that solutions register in their own setup()',
  [AddEventsStepTypeId]:
    'event attachments use the unified attachment types (such as security.event) that solutions register in their own setup(), which a task process does not run',
  [DeleteAttachmentsStepTypeId]:
    'deleting attachments removes the case from the alerts they link (the alerts client of the rule registry), deletes the files of file attachments (the files plugin) and reads the attachment types that solutions register',
  [DeleteCasesStepTypeId]:
    'deleting cases finds and deletes the files of the cases (the files plugin) and removes the cases from their alerts (the alerts client of the rule registry)',
};
