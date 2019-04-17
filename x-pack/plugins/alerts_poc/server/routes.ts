/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

import Joi from 'joi';
import { AlertService } from '../alert_service';

export function initRoutes(server: any, alertService: AlertService) {
  server.route({
    method: 'POST',
    path: '/api/schedule-action',
    options: {
      validate: {
        payload: Joi.object()
          .keys({
            id: Joi.string().required(),
            interval: Joi.number().required(),
            throttle: Joi.number().optional(),
            actionGroupsPriority: Joi.array()
              .items(Joi.string())
              .required(),
            actionGroups: Joi.object().required(),
            checkParams: Joi.object().default({}),
          })
          .required(),
      },
    },
    handler: async (request: any) => {
      alertService.schedule(request.payload);
      return { success: true };
    },
  });
}
