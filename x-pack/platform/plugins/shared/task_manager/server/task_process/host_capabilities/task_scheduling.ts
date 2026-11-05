/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { v4 } from 'uuid';
import { omit } from 'lodash';
import type { estypes } from '@elastic/elasticsearch';
import type { Logger } from '@kbn/logging';
import type { ElasticsearchClient } from '@kbn/core-elasticsearch-server';
import type {
  ISavedObjectsRepository,
  SavedObjectsClientContract,
} from '@kbn/core-saved-objects-api-server';
import {
  isSavedObjectErrorResult,
  SavedObjectsErrorHelpers,
  SECURITY_EXTENSION_ID,
  SPACES_EXTENSION_ID,
} from '@kbn/core-saved-objects-server';
import type { SavedObjectsServiceStart } from '@kbn/core-saved-objects-server';
import type { SecurityServiceStart } from '@kbn/core-security-server';
import type { KibanaRequest } from '@kbn/core-http-server';
import type { EncryptedSavedObjectTypeRegistration } from '@kbn/encrypted-saved-objects-plugin/server';
import type { ConcreteTaskInstance, TaskInstance } from '../../task';
import { TaskStatus } from '../../task';
import { TASK_MANAGER_INDEX } from '../../constants';
import { ensureDeprecatedFieldsAreCorrected } from '../../lib/correct_deprecated_fields';
import { getFirstRunAt } from '../../lib/get_first_run_at';
import { parseIntervalAsMillisecond } from '../../lib/intervals';
import {
  savedObjectToConcreteTaskInstance,
  taskInstanceToAttributes,
} from '../../lib/task_instance_serialization';
import type { TaskHost } from '../../task_type_module';
import { createApiKeyStrategy } from '../../api_key_strategy';
import type { ApiKeySOFields, ApiKeyType, InvalidationTarget } from '../../api_key_strategy';
import { INVALIDATE_API_KEY_SO_NAME } from '../../saved_objects';

const TASK_SO_NAME = 'task';

/**
 * The encrypted saved object registrations of the `task` and `api_key_to_invalidate` types: what makes
 * the credential a task is scheduled with (`apiKey`, `uiamApiKey`) readable only with the keys of Kibana.
 * A module that schedules tasks with `{ request }` declares them as `encryptedSavedObjectTypes`, and a
 * process registers them the way Kibana does.
 */
export const TASK_ENCRYPTED_SAVED_OBJECT_TYPE_REGISTRATIONS: EncryptedSavedObjectTypeRegistration[] =
  [
    {
      type: TASK_SO_NAME,
      attributesToEncrypt: new Set(['apiKey', 'uiamApiKey', 'encryptedCredential']),
      attributesToIncludeInAAD: new Set(['id', 'taskType', 'credential']),
      enforceRandomId: false,
    },
    {
      type: INVALIDATE_API_KEY_SO_NAME,
      attributesToEncrypt: new Set(['uiamApiKey']),
      attributesToIncludeInAAD: new Set(['apiKeyId', 'createdAt']),
    },
  ];

const addJitter = (interval?: string): { runAt: Date; scheduledAt: Date } => {
  // Adhoc tasks run immediately.
  if (!interval) return { runAt: new Date(), scheduledAt: new Date() };
  const now = Date.now();
  const maximumOffsetTimestamp = now + 1000 * 60 * 5; // now + 5 minutes
  const maximumRunAt = Math.min(now + parseIntervalAsMillisecond(interval), maximumOffsetTimestamp);
  const runAt = new Date(now + Math.floor(Math.random() * (maximumRunAt - now) + 1));
  return { runAt, scheduledAt: runAt };
};

/**
 * What a process needs to schedule tasks that run as the user of a request (`{ request }`, with
 * `cloneApiKey`), such as the `workflow:run` tasks of attack discovery. It is what Task Manager hands
 * its `TaskStore` in Kibana: the API key strategy built from the same settings, the saved objects
 * client that encrypts the credential (the module declares the `task` encrypted saved object type)
 * and Core's security.
 */
export interface HostTaskSchedulingCredentials {
  /** `getScopedClient` writes the `task` document with the request's encryption extension. */
  savedObjects: Pick<SavedObjectsServiceStart, 'getScopedClient' | 'getUnsafeInternalClient'>;
  /** Core's security start contract: the delegate the security task plugin registered grants the keys. */
  security: SecurityServiceStart;
  /** `taskManager.api_key_type` of Kibana. */
  apiKeyType: ApiKeyType;
  /** `taskManager.grant_uiam_api_keys` of Kibana. */
  grantUiamApiKeys: boolean;
  /** Whether the encrypted saved objects of this process can encrypt (it has the keys of Kibana). */
  canEncrypt: boolean;
  /** Whether security is enabled; tasks are written without credentials when it is not. Defaults to true. */
  isSecurityEnabled?: () => boolean;
}

export interface HostScheduleOptions {
  request?: KibanaRequest;
  cloneApiKey?: boolean;
  refreshApiKey?: boolean;
  onEsKey?: boolean;
  apiKey?: unknown;
}

type SoResult = { id: string; error?: Error } & Record<string, unknown>;

type SerializedTask = ReturnType<typeof taskInstanceToAttributes>;

const getCredentialConflict = (id: string) =>
  SavedObjectsErrorHelpers.decorateConflictError(
    new Error(
      `Task "${id}" has a credential and can't be overwritten. Remove it and schedule it again.`
    )
  ).output.payload;

/**
 * Schedules tasks from a task process the way `TaskScheduling` and `TaskStore` do, by writing `task`
 * saved objects. Kibana still claims, validates and runs them. With `credentials`, `{ request }`
 * grants the task an API key with the strategy `TaskStore` uses and writes the same credential fields
 * with the same encrypting client. Not supported here, and rejected by name: `runAs`, and a legacy
 * `apiKey` option. Not done either: the ad hoc task counter (so the `adhoc.created` metric
 * undercounts), `traceparent`, task definition validation (a process does not know the definitions,
 * `allowedTypes` limits what it may schedule) and nudging the claim cycle.
 */
export const createHostTaskScheduling = ({
  repository,
  esClient,
  logger,
  allowedTypes,
  credentials,
}: {
  repository: ISavedObjectsRepository;
  esClient: ElasticsearchClient;
  logger: Logger;
  /** Only task types that match may be scheduled; a process does not know the task definitions. */
  allowedTypes?: RegExp;
  credentials?: HostTaskSchedulingCredentials;
}): NonNullable<TaskHost['taskManager']> & {
  schedule: (
    taskInstance: TaskInstance,
    options?: HostScheduleOptions
  ) => Promise<ConcreteTaskInstance>;
} => {
  const strategy = credentials
    ? createApiKeyStrategy(
        credentials.apiKeyType,
        credentials.grantUiamApiKeys,
        credentials.security,
        logger
      )
    : undefined;

  const prepare = (taskInstance: TaskInstance & { runAs?: unknown }): TaskInstance => {
    const { runAs, ...rest } = taskInstance;
    if (runAs) {
      throw new Error('Scheduling a task with runAs is not supported from a task process');
    }
    if (allowedTypes && !allowedTypes.test(rest.taskType)) {
      throw new Error(`Task type ${rest.taskType} cannot be scheduled from a task process`);
    }
    return rest;
  };

  const getRequestOptions = (options?: HostScheduleOptions) => {
    if (options?.apiKey) {
      throw new Error('Scheduling with an apiKey option is not supported from a task process');
    }
    if (!options?.request) return undefined;
    if (!credentials || !strategy) {
      throw new Error(
        'Scheduling with a request is not supported from this task process: the module did not get credentials to grant API keys'
      );
    }
    if (!credentials.canEncrypt) {
      throw new Error(
        'Unable to schedule task(s) with API keys because the Encrypted Saved Objects plugin has not been registered or is missing encryption key.'
      );
    }
    return { request: options.request, credentials, strategy };
  };

  const willGrant = (options?: HostScheduleOptions) =>
    Boolean(options?.request) && (credentials?.isSecurityEnabled?.() ?? true);

  const getSoClientForCreate = (
    options?: HostScheduleOptions
  ): Pick<SavedObjectsClientContract, 'create' | 'bulkCreate'> =>
    options?.request && credentials && willGrant(options)
      ? credentials.savedObjects.getScopedClient(options.request, {
          includedHiddenTypes: [TASK_SO_NAME],
          excludedExtensions: [SECURITY_EXTENSION_ID, SPACES_EXTENSION_ID],
        })
      : repository;

  const grant = async (
    taskInstances: Array<TaskInstance & { id: string }>,
    options?: HostScheduleOptions
  ): Promise<Map<string, ApiKeySOFields>> => {
    const requestOptions = getRequestOptions(options);
    if (!requestOptions || !willGrant(options)) return new Map();
    const created: InvalidationTarget[] = [];
    try {
      return await requestOptions.strategy.grantApiKeys(
        taskInstances,
        requestOptions.request,
        requestOptions.credentials.security,
        {
          ...(options?.onEsKey === true ? { onEsKey: true } : {}),
          ...(options?.cloneApiKey === true ? { cloneApiKey: true } : {}),
          ...(options?.refreshApiKey !== undefined ? { refreshApiKey: options.refreshApiKey } : {}),
          onApiKeyCreated: (target) => created.push(target),
        }
      );
    } catch (e) {
      await markForInvalidation(created);
      throw e;
    }
  };

  // Best effort, so cleanup can never mask the failure that made it necessary.
  const markForInvalidation = async (targets: InvalidationTarget[]) => {
    if (!targets.length || !credentials || !strategy) return;
    try {
      await strategy.markForInvalidation(
        targets,
        logger,
        credentials.savedObjects.getUnsafeInternalClient({
          includedHiddenTypes: [INVALIDATE_API_KEY_SO_NAME],
        })
      );
    } catch (e) {
      logger.error(
        `Failed to mark ${targets.length} unused API keys for invalidation: ${e.message}`
      );
    }
  };

  const invalidateUnpersisted = async (fields: Array<ApiKeySOFields | undefined>) => {
    if (!strategy) return;
    const targets = fields.flatMap((f) => (f ? strategy.getApiKeyIdsForInvalidation(f) : []));
    await markForInvalidation(targets);
  };

  const schedule = async (taskInstance: TaskInstance, options?: HostScheduleOptions) => {
    const prepared = prepare(taskInstance);
    const corrected = ensureDeprecatedFieldsAreCorrected(prepared, logger);
    const task = {
      ...corrected,
      enabled: corrected.enabled ?? true,
      traceparent: '',
    } as TaskInstance;
    const id = task.id || v4();
    const granted = await grant([{ ...task, id }], options);
    const fields = granted.get(id);
    try {
      const so = await getSoClientForCreate(options).create<SerializedTask>(
        TASK_SO_NAME,
        {
          ...taskInstanceToAttributes(task, id),
          ...fields,
          runAt: getFirstRunAt({ taskInstance: task, logger }),
        } as never,
        { id, refresh: false }
      );
      return savedObjectToConcreteTaskInstance(so as never);
    } catch (e) {
      await invalidateUnpersisted([fields]);
      throw e;
    }
  };

  return {
    schedule,

    bulkSchedule: async (taskInstances, options) => {
      const requestOptions = getRequestOptions(options as HostScheduleOptions | undefined);
      const tasks = taskInstances.map((taskInstance, _, all) => {
        const corrected = ensureDeprecatedFieldsAreCorrected(prepare(taskInstance), logger);
        const enabled = corrected.enabled ?? true;
        let scheduling: Partial<{ runAt: Date; scheduledAt: Date }> = {};
        if (enabled) {
          // Run now if there is only a single task, otherwise add jitter so they do not fire together.
          scheduling =
            all.length === 1
              ? { runAt: new Date(), scheduledAt: new Date() }
              : addJitter(corrected.schedule?.interval);
        }
        return {
          ...corrected,
          id: corrected.id ?? v4(),
          enabled,
          traceparent: '',
          ...scheduling,
        } as TaskInstance & { id: string };
      });

      // An explicit id must never replace the credential of a task, nor give one to a task: only a
      // task read without a credential is overwritten, at the version that was read.
      const explicitIds = taskInstances.flatMap(({ id }) => (id ? [id] : []));
      const existing = new Map<string, { version?: string; hasCredential: boolean }>();
      if (explicitIds.length) {
        const { saved_objects: found } = await repository.bulkGet<SerializedTask>(
          explicitIds.map((id) => ({ type: TASK_SO_NAME, id }))
        );
        for (const so of found) {
          if (!isSavedObjectErrorResult(so)) {
            const { credential, encryptedCredential } = so.attributes;
            existing.set(so.id, {
              version: so.version,
              hasCredential: credential !== undefined || encryptedCredential !== undefined,
            });
          }
        }
      }
      const plans = tasks.map((task) => {
        const found = existing.get(task.id);
        if (found?.hasCredential) return { task, action: 'conflict' as const };
        if (found?.version) return { task, action: 'overwrite' as const, version: found.version };
        return { task, action: 'create' as const };
      });

      const granted = requestOptions
        ? await grant(
            plans.filter(({ action }) => action !== 'conflict').map(({ task }) => task),
            options as HostScheduleOptions
          )
        : new Map<string, ApiKeySOFields>();

      const toObject = ({ task }: { task: TaskInstance & { id: string } }, version?: string) => ({
        type: TASK_SO_NAME,
        id: task.id,
        attributes: {
          ...taskInstanceToAttributes(task, task.id),
          ...granted.get(task.id),
          runAt: getFirstRunAt({ taskInstance: task, logger }),
        },
        ...(version ? { version } : {}),
      });

      const client = getSoClientForCreate(options as HostScheduleOptions | undefined);
      const actions = ['create', 'overwrite'] as const;
      const planned = actions.map((action) => plans.filter((plan) => plan.action === action));
      const settled = await Promise.allSettled(
        planned.map(async (batch, index) => {
          if (!batch.length) return { saved_objects: [] as SoResult[] };
          const objects = batch.map((plan) =>
            toObject(plan, 'version' in plan ? plan.version : undefined)
          );
          return (await client.bulkCreate(objects as never, {
            refresh: false,
            overwrite: actions[index] === 'overwrite',
          })) as unknown as { saved_objects: SoResult[] };
        })
      );

      // Settles every write before cleaning up, so a failed write never invalidates the keys of a
      // write that persisted.
      const unpersisted: Array<ApiKeySOFields | undefined> = [];
      let writeError: Error | undefined;
      const results = new Map<(typeof plans)[number], SoResult>();
      settled.forEach((write, index) => {
        if (write.status === 'rejected') {
          writeError = writeError ?? write.reason;
          planned[index].forEach(({ task }) => unpersisted.push(granted.get(task.id)));
          return;
        }
        write.value.saved_objects.forEach((so, i) => {
          results.set(planned[index][i], so);
          if (so.error) unpersisted.push(granted.get(planned[index][i].task.id));
        });
      });
      if (unpersisted.length) await invalidateUnpersisted(unpersisted);
      if (writeError) throw writeError;

      return plans.map((plan) => {
        if (plan.action === 'conflict') throw getCredentialConflict(plan.task.id);
        const so = results.get(plan)!;
        if (so.error) throw so.error;
        return savedObjectToConcreteTaskInstance(so as never);
      }) as ConcreteTaskInstance[];
    },

    aggregate: async ({ aggs, query, runtime_mappings: runtimeMappings, size = 0 }) => {
      const filterToOnlyTasks = {
        bool: {
          filter: {
            bool: {
              must: [{ term: { type: 'task' } }, { term: { 'task.enabled': true } }],
              must_not: [{ term: { 'task.status': TaskStatus.Unrecognized } }],
            },
          },
        },
      };
      return await esClient.search<ConcreteTaskInstance>({
        index: TASK_MANAGER_INDEX,
        ignore_unavailable: true,
        ...omit({ aggs, runtime_mappings: runtimeMappings, size }, []),
        query: (query
          ? { bool: { must: [filterToOnlyTasks, query] } }
          : filterToOnlyTasks) as estypes.QueryDslQueryContainer,
      });
    },
  };
};
