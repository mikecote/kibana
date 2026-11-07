/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import Boom from '@hapi/boom';
import type { ElasticsearchClient, KibanaRequest } from '@kbn/core/server';
import type { AuditLogger, SecurityPluginStart } from '@kbn/security-plugin-types-server';
import {
  ALERTS_API_READ,
  ALERTS_API_ALL,
  ALERTS_API_UPDATE_DEPRECATED_PRIVILEGE,
} from '@kbn/security-solution-features/constants';
import type {
  AlertTriageAlertsClient,
  AlertTriageAlertsClientFactory,
  TriageAlertsSearchParams,
} from '@kbn/alertzero-plugin/server/alert_triage/alerts_client';
import { SearchAlertsRequestBody } from '../../../../common/api/detection_engine/signals';
import { SetAlertTagsRequestBody } from '../../../../common/api/detection_engine/alert_tags';
import type { AppClient } from '../../../client';
import type { SecuritySolutionEventBus } from '../../../events/event_bus';
import { validateSearchAlertsParams } from '../routes/common/validators/validate_search_alerts_params';
import { validateAlertTagsArrays } from '../routes/common/validators/validate_alert_arrays';
import { searchAlertsWithClient } from '../routes/common/operations/search_alerts';
import { updateAlertsTagsWithClient } from '../routes/common/operations/update_alerts_tags';
import { applyAlertTagsWithEvents } from '../routes/common/operations/apply_alert_tags_with_events';
import { auditAlertUpdatePreOperationFailure } from '../routes/common/operations/audit_alert_updates';

interface SecurityAlertsClientDependencies {
  getEsClient: (request: KibanaRequest) => ElasticsearchClient;
  getSearchIndex: (request: KibanaRequest) => string | undefined;
  getAppClient: (request: KibanaRequest) => AppClient | undefined;
  getAuditLogger: (request: KibanaRequest) => AuditLogger | undefined;
  getSecurity: () => Promise<Pick<SecurityPluginStart, 'authz'> | undefined>;
  eventBus?: Pick<SecuritySolutionEventBus, 'emitAlertTagsChanged'>;
}

/** Requires an owning Security alert index before a query can reach Elasticsearch. */
export const requireSecurityAlertsIndex = (index: string | undefined): string => {
  if (!index) throw Boom.serverUnavailable('The Security alerts index is not available');
  return index;
};

/** Builds request-scoped native Security alert operations with their validators, authorization and audit. */
export const createSecurityAlertsClientFactory =
  ({
    getEsClient,
    getSearchIndex,
    getAppClient,
    getAuditLogger,
    getSecurity,
    eventBus,
  }: SecurityAlertsClientDependencies): AlertTriageAlertsClientFactory =>
  async (request) => {
    const esClient = getEsClient(request);
    const assertAnyPrivilege = async (privileges: readonly string[]): Promise<void> => {
      const security = await getSecurity();
      if (!security) return;
      const check = security.authz.checkPrivilegesDynamicallyWithRequest(request);
      const grants = await Promise.all(
        privileges.map(async (privilege) => {
          const result = await check({ kibana: [security.authz.actions.api.get(privilege)] });
          return result.hasAllRequested;
        })
      );
      if (!grants.some(Boolean))
        throw Boom.forbidden(`Missing Security alerts privilege: ${privileges.join(' or ')}`);
    };
    const client: AlertTriageAlertsClient = {
      search: async <TDocument, TAggregations>(input: TriageAlertsSearchParams) => {
        await assertAnyPrivilege([ALERTS_API_READ]);
        const params = SearchAlertsRequestBody.parse(input);
        const error = validateSearchAlertsParams(params);
        if (error) throw Boom.badRequest(error);
        return searchAlertsWithClient<TDocument, TAggregations>({
          esClient,
          index: requireSecurityAlertsIndex(getSearchIndex(request)),
          params,
        });
      },
      updateTags: async (input) => {
        await assertAnyPrivilege([ALERTS_API_ALL, ALERTS_API_UPDATE_DEPRECATED_PRIVILEGE]);
        const { ids, tags } = SetAlertTagsRequestBody.parse(input);
        const errors = validateAlertTagsArrays(tags, ids);
        if (errors.length > 0) throw Boom.badRequest(JSON.stringify(errors));
        const auditLogger = getAuditLogger(request);
        const appClient = getAppClient(request);
        if (!appClient) {
          auditAlertUpdatePreOperationFailure(auditLogger, 'Alert update target unavailable');
          throw Boom.notFound('Alert update target unavailable');
        }
        const index = appClient.getAlertsIndex();
        return applyAlertTagsWithEvents({
          request,
          esClient,
          index,
          ids,
          tags,
          eventBus,
          update: () => updateAlertsTagsWithClient({ esClient, auditLogger, index, ids, tags }),
        });
      },
    };
    return client;
  };
