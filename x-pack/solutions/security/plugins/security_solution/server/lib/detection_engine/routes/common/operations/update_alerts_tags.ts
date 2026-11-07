/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { uniq } from 'lodash/fp';
import type { ElasticsearchClient } from '@kbn/core/server';
import type { AuditLogger } from '@kbn/security-plugin-types-server';
import type { Indices } from '@elastic/elasticsearch/lib/api/types';

import type { SecuritySolutionRequestHandlerContext } from '../../../../../types';
import type { SetAlertTagsRequestBody } from '../../../../../../common/api/detection_engine/alert_tags';
import {
  auditAlertUpdateFailure,
  auditAlertUpdateIntent,
  auditAlertUpdateResponseFailure,
} from './audit_alert_updates';

interface UpdateAlertsTagsArgs {
  context: SecuritySolutionRequestHandlerContext;
  index: Indices;
  ids: string[];
  tags: SetAlertTagsRequestBody['tags'];
}

/** Updates alert tags with the native scoped client and the owning request's audit logger. */
export const updateAlertsTagsWithClient = async ({
  esClient,
  auditLogger,
  index,
  ids,
  tags,
}: Omit<UpdateAlertsTagsArgs, 'context'> & {
  esClient: ElasticsearchClient;
  auditLogger: AuditLogger | undefined;
}) => {
  const target = { ids };

  auditAlertUpdateIntent(auditLogger, target);

  try {
    const response = await esClient.updateByQuery({
      index,
      refresh: true,
      script: getUpdateAlertTagsScript(tags),
      query: {
        bool: {
          filter: { terms: { _id: ids } },
        },
      },
      ignore_unavailable: true,
    });
    auditAlertUpdateResponseFailure(auditLogger, target, response);
    return response;
  } catch (error) {
    auditAlertUpdateFailure(
      auditLogger,
      target,
      error instanceof Error ? error : new Error(String(error))
    );
    throw error;
  }
};

/** Updates tags through the request context's genuine Elasticsearch and audit services. */
export const updateAlertsTags = async ({ context, index, ids, tags }: UpdateAlertsTagsArgs) => {
  const esClient = (await context.core).elasticsearch.client.asCurrentUser;
  const auditLogger = (await context.securitySolution).getAuditLogger();
  return updateAlertsTagsWithClient({ esClient, auditLogger, index, ids, tags });
};

export const getUpdateAlertTagsScript = (tags: SetAlertTagsRequestBody['tags']) => {
  const tagsToAdd = uniq(tags.tags_to_add);
  const tagsToRemove = uniq(tags.tags_to_remove);

  return {
    params: { tagsToAdd, tagsToRemove },
    source: `List newTagsArray = [];
        if (ctx._source["kibana.alert.workflow_tags"] != null) {
          for (tag in ctx._source["kibana.alert.workflow_tags"]) {
            if (!params.tagsToRemove.contains(tag)) {
              newTagsArray.add(tag);
            }
          }
          for (tag in params.tagsToAdd) {
            if (!newTagsArray.contains(tag)) {
              newTagsArray.add(tag)
            }
          }
          ctx._source["kibana.alert.workflow_tags"] = newTagsArray;
        } else {
          ctx._source["kibana.alert.workflow_tags"] = params.tagsToAdd;
        }
        `,
    lang: 'painless',
  };
};
