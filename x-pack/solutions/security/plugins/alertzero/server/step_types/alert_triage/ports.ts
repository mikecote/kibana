/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { set } from '@kbn/safer-lodash-set';
import { ExecutionStatus } from '@kbn/workflows';
import type { estypes } from '@elastic/elasticsearch';
import type { JsonObject, JsonValue } from '@kbn/utility-types';
import type { StepHandlerContext } from '@kbn/workflows-extensions/server';
import type { WorkflowExecutionReader } from '@kbn/workflows-management-plugin/server/api/create_workflow_execution_reader';
import type { TaskManagerStartContract } from '@kbn/task-manager-plugin/server';
import type { AlertTriageAlertsClient } from '../../alert_triage/alerts_client';
import {
  ALERT_FETCH_LIMIT,
  ALERT_SEVERITIES,
  BATCH_ALERT_CAP,
  OPEN_ALERT_STATUSES,
  RULE_FETCH_LIMIT,
  TRIAGE_FAILED_TAG,
  TRIAGE_PENDING_TAG,
  VERDICT_TAGS,
  type AlertSeverity,
} from '../../alert_triage/constants';
import type { SweepPorts } from '../../alert_triage/plan_sweep';
import type { TriageAlert } from '../../alert_triage/types';

const WORKFLOW_RUN_TASK_TYPE = 'workflow:run';

/** Statuses in which a batch holds or waits for work, as `coverage_worker.yaml` lists them. */
const LIVE_STATUSES = [
  ExecutionStatus.PENDING,
  ExecutionStatus.QUEUED,
  ExecutionStatus.WAITING,
  ExecutionStatus.WAITING_FOR_INPUT,
  ExecutionStatus.WAITING_FOR_CHILD,
  ExecutionStatus.RUNNING,
] as const;

const ALERT_FIELDS = {
  ruleId: 'kibana.alert.rule.uuid',
  ruleName: 'kibana.alert.rule.name',
  riskScore: 'kibana.alert.risk_score',
  status: 'kibana.alert.workflow_status',
  tags: 'kibana.alert.workflow_tags',
  timestamp: '@timestamp',
} as const;

const readField = (source: JsonObject, field: string): JsonValue | undefined => {
  if (field in source) return source[field];
  return field
    .split('.')
    .reduce<JsonValue | undefined>(
      (value, key) =>
        typeof value === 'object' && value !== null && !Array.isArray(value)
          ? value[key]
          : undefined,
      source
    );
};

type AlertHit = estypes.SearchHit<JsonObject>;

const toTriageAlert = ({ _id, _source = {} }: AlertHit): TriageAlert => {
  if (!_id) throw new Error('A Security alert search hit has no id');
  const tags = readField(_source, ALERT_FIELDS.tags);
  const timestamp = readField(_source, ALERT_FIELDS.timestamp);
  return {
    id: _id,
    ruleId: String(readField(_source, ALERT_FIELDS.ruleId) ?? ''),
    ruleName: String(readField(_source, ALERT_FIELDS.ruleName) ?? ''),
    riskScore: Number(readField(_source, ALERT_FIELDS.riskScore) ?? 0),
    timestamp: typeof timestamp === 'number' ? timestamp : Date.parse(String(timestamp)) || 0,
    status: String(readField(_source, ALERT_FIELDS.status) ?? ''),
    tags: Array.isArray(tags) ? tags.map(String) : [],
  };
};

export const listLiveExecutionIds = async (
  reader: WorkflowExecutionReader,
  context: Pick<StepHandlerContext['contextManager'], 'getFakeRequest'>,
  batchWorkflowId: string,
  logger?: Pick<StepHandlerContext['logger'], 'warn'>
): Promise<Set<string> | undefined> => {
  try {
    const body = await reader.getWorkflowExecutions({
      workflowId: batchWorkflowId,
      statuses: [...LIVE_STATUSES],
      size: 100,
      request: context.getFakeRequest(),
    });
    return new Set(body.results.map(({ id }) => id));
  } catch (error) {
    logger?.warn(
      `Could not list live executions of ${batchWorkflowId}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return undefined;
  }
};

/** Age of the oldest overdue `workflow:run` task. Cluster-wide, see `readHeadroom`. */
export const readWorkflowRunLagMs = async (
  taskManager: Pick<TaskManagerStartContract, 'aggregate'>,
  now: number
): Promise<number> => {
  const response = await taskManager.aggregate({
    size: 0,
    query: {
      bool: {
        filter: [
          { term: { 'task.taskType': WORKFLOW_RUN_TASK_TYPE } },
          { term: { 'task.status': 'idle' } },
          { range: { 'task.runAt': { lte: new Date(now).toISOString() } } },
        ],
      },
    },
    aggs: { oldest: { min: { field: 'task.runAt' } } },
  });
  const oldest = (response.aggregations?.oldest as { value: number | null } | undefined)?.value;
  return typeof oldest === 'number' ? Math.max(0, now - oldest) : 0;
};

/** Most urgent first: highest risk, then oldest. */
const URGENCY_SORT: estypes.Sort = [
  { [ALERT_FIELDS.riskScore]: 'desc' },
  { [ALERT_FIELDS.timestamp]: 'asc' },
];

const searchAlerts = async (
  client: AlertTriageAlertsClient,
  query: estypes.QueryDslQueryContainer
): Promise<TriageAlert[]> => {
  const body = await client.search({
    size: ALERT_FETCH_LIMIT,
    _source: Object.values(ALERT_FIELDS),
    sort: URGENCY_SORT,
    query,
  });
  return body.hits.hits.map(toTriageAlert);
};

/**
 * The most urgent alerts of each rule, rules ordered by their most urgent alert. A batch holds at
 * most `BATCH_ALERT_CAP` alerts, so a rule with a large backlog contributes one batch's worth and
 * cannot fill the result and crowd quieter rules out of the plan.
 */
const searchAlertsPerRule = async (
  client: AlertTriageAlertsClient,
  query: estypes.QueryDslQueryContainer
): Promise<TriageAlert[]> => {
  const body = await client.search<
    JsonObject,
    {
      rules?: { buckets?: Array<{ top?: { hits?: { hits?: AlertHit[] } } }> };
    }
  >({
    size: 0,
    query,
    aggs: {
      rules: {
        terms: {
          field: ALERT_FIELDS.ruleId,
          size: RULE_FETCH_LIMIT,
          order: [{ most_urgent_risk: 'desc' }, { oldest: 'asc' }],
        },
        aggs: {
          most_urgent_risk: { max: { field: ALERT_FIELDS.riskScore } },
          oldest: { min: { field: ALERT_FIELDS.timestamp } },
          top: {
            top_hits: {
              size: BATCH_ALERT_CAP,
              _source: Object.values(ALERT_FIELDS),
              sort: URGENCY_SORT,
            },
          },
        },
      },
    },
  });
  const buckets = body.aggregations?.rules?.buckets;
  // An empty result would read as an idle queue, so a response without the aggregation fails.
  if (buckets === undefined) throw new Error('Per-rule alerts missing from the search response');
  return buckets.flatMap(({ top }) => (top?.hits?.hits ?? []).map(toTriageAlert));
};

/** Alerts no triage or analysis has touched: no verdict, failure, claim or analysis tag. */
const UNTRIAGED_MUST_NOT = (analysisTagPrefix: string) => [
  { terms: { [ALERT_FIELDS.tags]: [...VERDICT_TAGS, TRIAGE_FAILED_TAG, TRIAGE_PENDING_TAG] } },
  { prefix: { [ALERT_FIELDS.tags]: analysisTagPrefix } },
];

export interface TriageFilters {
  minSeverity: AlertSeverity;
  excludeBuildingBlocks: boolean;
  excludedRuleTags: readonly string[];
}

// Filter-only fields: kept out of `ALERT_FIELDS`, which also decides which fields are fetched.
const SEVERITY_FIELD = 'kibana.alert.severity';
const BUILDING_BLOCK_TYPE_FIELD = 'kibana.alert.building_block_type';
const RULE_TAGS_FIELD = 'kibana.alert.rule.tags';

/** Alerts the settings keep from ever reaching a Worker, beyond the untriaged check. */
const excludedByFilters = ({ excludeBuildingBlocks, excludedRuleTags }: TriageFilters) => [
  ...(excludeBuildingBlocks ? [{ exists: { field: BUILDING_BLOCK_TYPE_FIELD } }] : []),
  ...(excludedRuleTags.length > 0 ? [{ terms: { [RULE_TAGS_FIELD]: [...excludedRuleTags] } }] : []),
];

/** No clause for `low`: the lowest severity admits every alert, including ones with no severity. */
const severityFilter = (minSeverity: AlertSeverity) =>
  minSeverity === ALERT_SEVERITIES[0]
    ? []
    : [
        {
          terms: {
            [SEVERITY_FIELD]: ALERT_SEVERITIES.slice(ALERT_SEVERITIES.indexOf(minSeverity)),
          },
        },
      ];

/** Claimed alerts the settings now exclude, so a stale claim is released but not planned again. */
const searchExcludedClaims = async (
  client: AlertTriageAlertsClient,
  filters: TriageFilters
): Promise<Set<string>> => {
  const severity = severityFilter(filters.minSeverity);
  const excluded = excludedByFilters(filters);
  if (severity.length === 0 && excluded.length === 0) return new Set();
  const alerts = await searchAlerts(client, {
    bool: {
      filter: [
        { terms: { [ALERT_FIELDS.status]: [...OPEN_ALERT_STATUSES] } },
        { term: { [ALERT_FIELDS.tags]: TRIAGE_PENDING_TAG } },
      ],
      // The negation of the unclaimed search's own conditions, so both read the settings the same way.
      must_not: [{ bool: { filter: severity, must_not: excluded } }],
    },
  });
  return new Set(alerts.map(({ id }) => id));
};

/**
 * Open alerts created since `windowStart` that still need triage, so the look-back is the search
 * window and older alerts are never read or tagged. They are read per rule, the most urgent
 * `BATCH_ALERT_CAP` of each, so one rule's backlog cannot hide the others. Claimed alerts come from
 * a separate query with no time bound, so a claim on a low-risk or aged-out alert is still seen and
 * can be reclaimed. Claims the settings now exclude are flagged so they are released, not re-planned.
 */
export const fetchTriageAlerts = async (
  client: AlertTriageAlertsClient,
  analysisTagPrefix: string,
  windowStart: number,
  filters: TriageFilters
): Promise<TriageAlert[]> => {
  const openStatus = { terms: { [ALERT_FIELDS.status]: [...OPEN_ALERT_STATUSES] } };
  const [unclaimed, claimed, excludedClaimIds] = await Promise.all([
    searchAlertsPerRule(client, {
      bool: {
        filter: [
          openStatus,
          { range: { [ALERT_FIELDS.timestamp]: { gte: new Date(windowStart).toISOString() } } },
          ...severityFilter(filters.minSeverity),
        ],
        must_not: [...UNTRIAGED_MUST_NOT(analysisTagPrefix), ...excludedByFilters(filters)],
      },
    }),
    searchAlerts(client, {
      bool: { filter: [openStatus, { term: { [ALERT_FIELDS.tags]: TRIAGE_PENDING_TAG } }] },
    }),
    searchExcludedClaims(client, filters),
  ]);
  return [
    ...unclaimed,
    ...claimed.map((alert) =>
      excludedClaimIds.has(alert.id) ? { ...alert, excludedBySettings: true } : alert
    ),
  ];
};

/**
 * Throws unless the whole update was applied: a claim or release that was only partly stored would
 * otherwise be reported as done, and the next sweep could plan the same alerts again.
 */
export const tagAlerts =
  (client: AlertTriageAlertsClient): SweepPorts['tagAlerts'] =>
  async ({ alertIds, add, remove }) => {
    const body = await client.updateTags({
      ids: [...alertIds],
      tags: { tags_to_add: [...add], tags_to_remove: [...remove] },
    });
    const failureCount = body.failures?.length ?? 0;
    if (body.timed_out === true || failureCount > 0) {
      throw new Error(
        `Tagging ${alertIds.length} alert(s) was not fully applied (timed_out: ${
          body.timed_out === true
        }, failures: ${failureCount})`
      );
    }
  };

/** One count query, no writes: open alerts older than the look-back that were never triaged. */
export const countAgedOutAlerts = async (
  client: AlertTriageAlertsClient,
  analysisTagPrefix: string,
  windowStart: number,
  filters: TriageFilters
): Promise<number> => {
  const body = await client.search({
    size: 0,
    track_total_hits: true,
    query: {
      bool: {
        filter: [
          { terms: { [ALERT_FIELDS.status]: [...OPEN_ALERT_STATUSES] } },
          { range: { [ALERT_FIELDS.timestamp]: { lt: new Date(windowStart).toISOString() } } },
          ...severityFilter(filters.minSeverity),
        ],
        must_not: [...UNTRIAGED_MUST_NOT(analysisTagPrefix), ...excludedByFilters(filters)],
      },
    },
  });
  const total = body.hits?.total;
  if (typeof total === 'number') return total;
  if (typeof total?.value === 'number') return total.value;
  throw new Error('Aged-out alert count missing from the search response');
};

export interface LoadedAlerts {
  alerts: JsonObject[];
  missingAlertIds: string[];
}

/**
 * The alerts index stores `kibana.*` as flat dotted keys next to nested ECS objects. Alert
 * Analysis requires the nested `kibana.alert.rule.uuid` shape, so dotted keys are expanded.
 */
const expandDottedKeys = (source: JsonObject): JsonObject =>
  Object.entries(source).reduce<JsonObject>((expanded, [key, value]) => {
    if (key.includes('.')) {
      set(expanded, key, value);
    } else {
      expanded[key] = value;
    }
    return expanded;
  }, {});

/** Loads a batch's alert documents by id, as `{ _id, _index, ...source }` for Alert Analysis. */
export const loadAlertsByIds = async (
  client: AlertTriageAlertsClient,
  alertIds: readonly string[]
): Promise<LoadedAlerts> => {
  const body = await client.search({
    size: alertIds.length,
    query: { ids: { values: [...alertIds] } },
  });
  const hits = body.hits.hits;
  const found = new Set(hits.map(({ _id }) => _id));
  return {
    alerts: hits.map(({ _id, _index, _source = {} }) => {
      if (!_id) throw new Error('A Security alert search hit has no id');
      return { ...expandDottedKeys(_source), _id, _index };
    }),
    missingAlertIds: alertIds.filter((id) => !found.has(id)),
  };
};
