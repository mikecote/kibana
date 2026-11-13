/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { of } from 'rxjs';
import { unsecuredActionsClientMock } from '@kbn/actions-plugin/server/unsecured_actions_client/unsecured_actions_client.mock';
import { License } from '@kbn/licensing-plugin/common/license';
import { loggerMock } from '@kbn/logging-mocks';
import { createEmailService } from './create_email_service';

const createLicense = (type: 'platinum' | 'basic') =>
  new License({
    license: {
      uid: 'email-license',
      type,
      mode: type,
      status: 'active',
      expiryDateInMillis: Date.now() + 86400000,
    },
    features: {},
    signature: 'email-license',
  });

it('schedules native notification actions for every HTML email recipient', async () => {
  const actionsClient = unsecuredActionsClientMock.create();
  actionsClient.bulkEnqueueExecution.mockResolvedValue({ errors: false, items: [] });
  const email = createEmailService({
    connectorId: 'configured-email',
    actionsClient,
    license$: of(createLicense('platinum')),
    logger: loggerMock.create(),
  });
  await email.sendHTMLEmail({
    to: ['one@example.test', 'two@example.test'],
    subject: 'Case assigned',
    message: 'Assigned',
    messageHTML: '<p>Assigned</p>',
    context: { relatedObjects: [{ type: 'cases', id: 'case-1' }] },
  });
  expect(actionsClient.bulkEnqueueExecution).toHaveBeenCalledWith(
    'notifications',
    ['one@example.test', 'two@example.test'].map((to) => ({
      id: 'configured-email',
      params: {
        to: [to],
        subject: 'Case assigned',
        message: 'Assigned',
        messageHTML: '<p>Assigned</p>',
      },
      relatedSavedObjects: [{ type: 'cases', id: 'case-1' }],
    }))
  );
});

it('enforces the native notification license before scheduling actions', async () => {
  const actionsClient = unsecuredActionsClientMock.create();
  const email = createEmailService({
    connectorId: 'configured-email',
    actionsClient,
    license$: of(createLicense('basic')),
    logger: loggerMock.create(),
  });
  await expect(
    email.sendPlainTextEmail({
      to: ['one@example.test'],
      subject: 'Case assigned',
      message: 'Assigned',
    })
  ).rejects.toThrow('The current license does not allow sending email notifications');
  expect(actionsClient.bulkEnqueueExecution).not.toHaveBeenCalled();
});
