/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Logger } from '@kbn/core/server';
import type { IUnsecuredActionsClient } from '@kbn/actions-plugin/server';
import type { ILicense } from '@kbn/licensing-types';
import type { Observable } from 'rxjs';
import { PLUGIN_ID } from '../../common';
import { ConnectorsEmailService } from './connectors_email_service';
import { LicensedEmailService } from './licensed_email_service';
import type { EmailService } from './types';

/** Creates the connector-backed, license-checked email service used by Main and task processes. */
export const createEmailService = ({
  connectorId,
  actionsClient,
  license$,
  logger,
}: {
  connectorId: string;
  actionsClient: IUnsecuredActionsClient;
  license$: Observable<ILicense>;
  logger: Logger;
}): EmailService =>
  new LicensedEmailService(
    new ConnectorsEmailService(PLUGIN_ID, connectorId, actionsClient, logger),
    license$,
    'platinum',
    logger
  );
