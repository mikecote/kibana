/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ElasticsearchClient, KibanaRequest } from '@kbn/core/server';
import type { estypes } from '@elastic/elasticsearch';
import { ALERT_WORKFLOW_TAGS } from '@kbn/rule-data-utils';
import type { SetAlertTagsRequestBody } from '../../../../../../common/api/detection_engine/alert_tags';
import type { SecuritySolutionEventBus } from '../../../../../events/event_bus';
import {
  MAX_ALERTS_PER_TRIGGER,
  MAX_TAG_LENGTH,
  MAX_TAGS_PER_OPERATION,
} from '../../../../../../common/workflows/triggers';
import { prefetchChangedListFieldIds } from './prefetch_previous_statuses';

interface AlertTagsCommandOptions {
  request: KibanaRequest;
  esClient: ElasticsearchClient;
  index: string;
  ids: string[];
  tags: SetAlertTagsRequestBody['tags'];
  eventBus?: Pick<SecuritySolutionEventBus, 'emitAlertTagsChanged'>;
  update: () => Promise<estypes.UpdateByQueryResponse>;
}

/** Applies tag changes and emits only the native observed delta after the write succeeds. */
export const applyAlertTagsWithEvents = async ({
  request,
  esClient,
  index,
  ids,
  tags,
  eventBus,
  update,
}: AlertTagsCommandOptions): Promise<estypes.UpdateByQueryResponse> => {
  const allValidTagsToAdd = tags.tags_to_add.filter((t) => t.length <= MAX_TAG_LENGTH);
  const allValidTagsToRemove = tags.tags_to_remove.filter((t) => t.length <= MAX_TAG_LENGTH);
  const cappedTagsToAdd = allValidTagsToAdd.slice(0, MAX_TAGS_PER_OPERATION);
  const cappedTagsToRemove = allValidTagsToRemove.slice(0, MAX_TAGS_PER_OPERATION);
  const operationTruncated =
    allValidTagsToAdd.length !== tags.tags_to_add.length ||
    allValidTagsToRemove.length !== tags.tags_to_remove.length ||
    allValidTagsToAdd.length > MAX_TAGS_PER_OPERATION ||
    allValidTagsToRemove.length > MAX_TAGS_PER_OPERATION;
  // Suppress the event if the prefetch fails: the delta is unknown and emitting
  // request intent as an observed fact violates the fact-style payload contract.
  let changedAlertIds: string[] = [];
  let tagsActuallyAdded = cappedTagsToAdd;
  let tagsActuallyRemoved = cappedTagsToRemove;
  if (eventBus) {
    try {
      ({
        changedIds: changedAlertIds,
        actualAdded: tagsActuallyAdded,
        actualRemoved: tagsActuallyRemoved,
      } = await prefetchChangedListFieldIds(
        esClient,
        index,
        ids,
        ALERT_WORKFLOW_TAGS,
        tags.tags_to_add,
        tags.tags_to_remove,
        cappedTagsToAdd,
        cappedTagsToRemove
      ));
    } catch {
      // prefetch failure is non-blocking; changedAlertIds stays empty, suppressing the event
    }
  }

  const result = await update();
  if (eventBus && changedAlertIds.length > 0) {
    void eventBus.emitAlertTagsChanged(request, {
      alertIds: changedAlertIds.slice(0, MAX_ALERTS_PER_TRIGGER),
      tagsAdded: tagsActuallyAdded,
      tagsRemoved: tagsActuallyRemoved,
      truncated: changedAlertIds.length > MAX_ALERTS_PER_TRIGGER || operationTruncated,
    });
  }
  return result;
};
