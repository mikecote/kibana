# Task type modules

A task type module is one file that holds a Task Manager task type: its definition and its runner.
Kibana registers it as it does any task type. The same file can also be bundled and run in a
process of its own, with Kibana still claiming, validating, timing out and rescheduling the task.

```ts
// <plugin>/server/task_types/my_task.task.ts
import { defineTaskType } from '@kbn/task-manager-plugin/server';

export const taskType = defineTaskType({
  type: 'myPlugin:my_task',
  title: 'My task',                       // everything `registerTaskDefinitions` takes, but the runner
  timeout: '1m',
  savedObjectTypes: [myType],             // only if the runner uses saved objects
  createTaskRunner: (context, { logger, elasticsearch, savedObjects }) => ({
    run: async () => ({ state: {} }),
    cancel: async () => {},
  }),
});
```

The second argument is the **host**: what the runner may use. In Kibana it is Core; in a process it
is built from Core's logging system, Elasticsearch client and saved objects repository. The module
never knows which, so it must not reach for anything else (plugin globals, `getStartServices`).

## Moving a task type into a module

1. Move the definition and runner into `server/task_types/<name>.task.ts`. Replace what the runner
   closed over with the host. Keep the scheduling code where it is and import the constants.
2. Import leaf files only. A barrel import pulls the whole plugin into the bundle.
3. List the file in `kibana.jsonc`: `"plugin": { "taskTypes": ["server/task_types/my_task.task.ts"] }`.
4. In `setup`, call `taskManager.registerTaskType(taskType, { logger })` instead of
   `registerTaskDefinitions`. `logger` is optional and defaults to Task Manager's.
5. Test the module with a fake host: `taskType.createTaskRunner(context, host)`.

`cleanup()` runs in the process after each run, so a runner that deletes its params there keeps working.

## Where tasks run

One setting decides it for every task type that is a module. Task types that are not modules always
run in Kibana, and Kibana claims, validates, times out and reschedules every task whatever the mode.

```yaml
xpack.task_manager.task_execution:
  mode: in_process      # default: in Kibana's process
```

**`child_process`.** Each run forks the task type's bundle, sends it Kibana's own Elasticsearch
connection over the fork channel, runs the task in it and stops it when the run ends. If the process
cannot be started, that run goes to Kibana.

```yaml
xpack.task_manager.task_execution:
  mode: child_process
  bundle_dir: target/task_bundles   # optional; the distributable uses its own task_bundles
```

Build the bundles with `node scripts/task_bundle` (the distributable builds them for you).

**`remote`.** Runs go to a task process you start yourself from the same bundle, so it can live on
another host. It serves the one task type of its bundle and answers 404 for any other, which then
runs in Kibana.

```yaml
xpack.task_manager.task_execution:
  mode: remote
  remote:
    url: http://localhost:4100
    token: secret                   # the process's TASK_PROCESS_TOKEN, if it has one
```

```
ES_URL=http://localhost:9200 ES_USERNAME=kibana_system ES_PASSWORD=secret PORT=4100 TASK_PROCESS_TOKEN=secret \
  node target/task_bundles/taskManager__delete_inactive_nodes.js
```

A remote process does not receive Kibana's settings, so it takes `ES_URL`, `ES_API_KEY` or both of
`ES_USERNAME` and `ES_PASSWORD` (there is no default user), `PORT` and `TASK_PROCESS_TOKEN` from its
environment. A run for a process that is down is retried shortly. A process built for another Kibana
version refuses runs.

## What a process has, and does not

Always: a logger, Core's Elasticsearch client (also scoped to the task's API key), the internal saved
objects repository for the types the module declares, an execution context that passes through, Core's
default security (no user, no audit, no UIAM keys), and Kibana's identity (`host.server`: server UUID,
version, build number, public base URL, serverless flag).

A module asks for more by declaring it, and the host builds only what is declared. In Kibana the
plugin that registers the task type hands over its own service for the same capability, so a module
runs the same in both.

| Declare | `host` gets | In a process | In Kibana |
| --- | --- | --- | --- |
| `savedObjectTypes` | saved object types registered | Core's repository and a client provider: `getScopedClient` and `getUnsafeInternalClient` take the space from the fake request, use the internal user, and have no security extension | Core |
| `encryptedSavedObjectTypes` | `encryptedSavedObjects` | the plugin's own service and client with the encryption keys the process is sent | `hostExtensions.encryptedSavedObjects` |
| `eventLog` | `eventLog` | the event log plugin's writer (its own adapter and service), stamped with Kibana's server UUID, flushed when the process stops; Kibana owns the data stream | `hostExtensions.eventLog` |
| `taskManager` | `taskManager` (`bulkSchedule`, `aggregate`) | writes `task` saved objects; no `runAs`, explicit ids or API key options, only the task types the module allows | Task Manager's start contract |
| `uiSettings` | `uiSettings` | Core's `UiSettingsClient` with Core's defaults and the module's | Core |
| `licensing` | `licensing.license$` | the license, read from Elasticsearch once | the licensing plugin |
| `settings: ['pluginId']` | `settings.pluginId` | the validated config the process is sent | the getter passed to `registerTaskType` |

```ts
taskManager.registerTaskType(taskType, {
  hostExtensions: { getEncryptionKeys: () => esoSetup.getKeysForTaskProcesses() },
  settings: { myPlugin: () => config },   // sent to the task process of this task type
});
```

What a process is sent is decided by the plugin that registers the task type, and the module reads the
parts it declared. Configs travel with `serializeSettings`, which keeps durations, byte sizes and
dates. The encryption keys and plugin configs, which can hold secrets, go over the fork channel, the
same trust as the Elasticsearch credentials; never log them.

Does not have yet: user-profile enrichment of the fake request, spaces beyond the one of the fake
request (an explicit `namespace` is honoured and `*` is not expanded), the event log query client,
other plugins' contracts, HTTP routes, UIAM API keys (stateful only for now). A task type that needs
them stays in Kibana, or declines the run.

### Declining a run

A runner may throw `DeclinedRunError` when it cannot serve this run, such as a rule that uses a
connector type the process does not know. The process answers `422`, and Kibana runs the task itself,
as it does for a `404`. Decide before the run has side effects.

### Remote processes

A remote process reads the same things from its environment: `ES_URL` with `ES_API_KEY` or
`ES_USERNAME` and `ES_PASSWORD`, `PORT`, `TASK_PROCESS_TOKEN`, `ESO_ENCRYPTION_KEY` and
`ESO_DECRYPTION_ONLY_KEYS` (comma separated), `KIBANA_SERVER_UUID`, `KIBANA_BUILD_NUM`,
`KIBANA_PUBLIC_BASE_URL`, `KIBANA_SERVERLESS`, and `TASK_PROCESS_SETTINGS`, the path of a JSON file
`{ "settings": { "<pluginId>": <config> }, "uiSettingsOverrides": {} }` whose configs use the format of
`serializeSettings` (a duration is `{"__kind":"duration","ms":1000}`).

## Bundles

`node scripts/task_bundle` builds one bundle per file in `plugin.taskTypes`. Workspace source is
treated as free of import-time side effects, so a barrel such as `@kbn/task-manager-plugin/server`
costs only what is used from it. Keep imports to the leaf that has what you need anyway: a module that
reaches a plugin class through a barrel still pays for what that class uses.

## Alerting rule types

Every rule type is a task type module, `alerting:<ruleTypeId>`, built by `createRuleTaskType`
(`alerting/server/task_types/rule_task_type.ts`). Kibana registers it from the rule type and runs it
with the alerting plugin's services. The plugin that owns the rule type adds a module file to its
`plugin.taskTypes`, which builds the same rule type from the host and runs the same `TaskRunner` with
services rebuilt from the host (`task_types/standalone`): rules settings, maintenance windows, the
alerts service, an enqueue-only actions runtime (`actions/server/task_types/rule_run_actions.ts`),
data views, search and the locators the module lists.

```ts
// <plugin>/server/task_types/my_rule.task.ts
export const taskType = createRuleTaskType(
  { ruleTypeId: MY_RULE_ID, getRuleType: ({ isServerless, locators, settings }) => getRuleType(isServerless) },
  { locators: [createDiscoverAppLocatorDefinition()], registerConnectorTypes: registerConnectorTypesForRuleRuns }
);
```

A factory takes what the host has (`logger`, `isServerless`, `publicBaseUrl`, `settings`, `locators`),
and a plugin whose rule types read its config calls `alerting.registerTaskProcessSettings(id, getConfig)`.
Add a test with `expectModuleToMatchRegisteredRuleType` so the module and the plugin cannot drift.

Rule types that need other plugins' runtimes use `createUnsupportedRuleTaskType(id, reason)`: a module
with `declinesAll`. Its bundle is built from a minimal entry (no Core, about 3 MB), the manifest marks
it, and in `child_process` mode Kibana does not start a process for it, because it knows the answer:
the rule runs in Kibana exactly as before, until the executor can be built from the host. A remote
process serves it by answering every run with `422`. Today that is the machine learning based rule types, the infra, synthetics and
security detection rule types, and attack discovery.

Not the same in a process: no `alert.status.changed` workflow events, usage counters or in-memory
metrics; connector authorization of the enqueue is not checked until Kibana runs the connector task;
a rule that uses a connector type or connector adapter the process does not know is declined; and
each run is a fresh process, so it pays for the encryption service, the license and the alerts
resource checks every time.

The distributable builds the bundles into `task_bundles/`.
