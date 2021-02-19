/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

import {
  Threat,
  ThreatTechnique,
  ThreatSubtechnique,
} from '../../../../common/detection_engine/schemas/common/schemas';
import { transformRuleToAlertAction } from '../../../../common/detection_engine/transform_actions';
import { Alert } from '../../../../../alerts/common';
import { SERVER_APP_ID, SIGNALS_ID } from '../../../../common/constants';
import { CreateRulesOptions } from './types';
import { addTags } from './add_tags';
import { PartialFilter, RuleTypeParams } from '../types';

export const createRules = async ({
  alertsClient,
  anomalyThreshold,
  author,
  buildingBlockType,
  description,
  enabled,
  eventCategoryOverride,
  falsePositives,
  from,
  query,
  language,
  license,
  savedId,
  timelineId,
  timelineTitle,
  meta,
  machineLearningJobId,
  filters,
  ruleId,
  immutable,
  index,
  interval,
  maxSignals,
  riskScore,
  riskScoreMapping,
  ruleNameOverride,
  outputIndex,
  name,
  severity,
  severityMapping,
  tags,
  threat,
  threatFilters,
  threatIndex,
  threatLanguage,
  concurrentSearches,
  itemsPerSearch,
  threatQuery,
  threatMapping,
  threshold,
  timestampOverride,
  to,
  type,
  references,
  note,
  version,
  exceptionsList,
  actions,
}: CreateRulesOptions): Promise<Alert<RuleTypeParams>> => {
  const searchable = [
    {
      field: 'author',
      value: author,
    },
    {
      field: 'description',
      value: description,
    },
    {
      field: 'note',
      value: note,
    },
    {
      field: 'falsePositives',
      value: falsePositives,
    },
  ];
  (threat || []).forEach((t: Threat) => {
    searchable.push({ field: 'threat.framework', value: t.framework });
    if (t.tactic) {
      searchable.push({ field: 'threat.tactic.id', value: t.tactic.id });
      searchable.push({ field: 'threat.tactic.name', value: t.tactic.name });
    }
    if (t.technique) {
      t.technique.forEach((tt: ThreatTechnique) => {
        searchable.push({ field: 'threat.technique.id', value: tt.id });
        searchable.push({ field: 'threat.technique.name', value: tt.name });
        if (tt.subtechnique) {
          tt.subtechnique.forEach((tts: ThreatSubtechnique) => {
            searchable.push({
              field: 'threat.technique.subtechnique.id',
              value: tts.id,
            });
            searchable.push({
              field: 'threat.technique.subtechnique.name',
              value: tts.name,
            });
          });
        }
      });
    }
  });
  return alertsClient.create<RuleTypeParams>({
    data: {
      name,
      tags: addTags(tags, ruleId, immutable),
      alertTypeId: SIGNALS_ID,
      consumer: SERVER_APP_ID,
      params: {
        anomalyThreshold,
        author,
        buildingBlockType,
        description,
        ruleId,
        index,
        eventCategoryOverride,
        falsePositives,
        from,
        immutable,
        query,
        language,
        license,
        outputIndex,
        savedId,
        timelineId,
        timelineTitle,
        meta,
        machineLearningJobId,
        filters,
        maxSignals,
        riskScore,
        riskScoreMapping,
        ruleNameOverride,
        severity,
        severityMapping,
        threat,
        threshold,
        /**
         * TODO: Fix typing inconsistancy between `RuleTypeParams` and `CreateRulesOptions`
         */
        threatFilters: threatFilters as PartialFilter[] | undefined,
        threatIndex,
        threatQuery,
        concurrentSearches,
        itemsPerSearch,
        threatMapping,
        threatLanguage,
        timestampOverride,
        to,
        type,
        references,
        note,
        version,
        exceptionsList,
      },
      searchable,
      schedule: { interval },
      enabled,
      actions: actions.map(transformRuleToAlertAction),
      throttle: null,
      notifyWhen: null,
    },
  });
};
