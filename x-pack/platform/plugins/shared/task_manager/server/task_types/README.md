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
is built from Core's own services. The module
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

## What a process is

A task process is **Core**. It boots the same `Root` Kibana does, with a fixed set of plugins instead of
plugin discovery, no HTTP listener, saved object migrations skipped and no translations. Everything a
run touches is Core's own service: the Elasticsearch client, saved objects, ui settings, analytics,
the security service, feature flags. Booting costs about 150 ms after the bundle loads.

The plugins are Task Manager (it collects the task definitions), the encrypted saved objects plugin
when the module declares encrypted types, any `taskPlugins` the module brings (such as the security
plugin's slim task plugin, which registers Core's security delegate so API keys, UIAM, privilege
checks and audit are the security plugin's), and one plugin that adapts the module: it registers what
the module declares and gives the runner its `host` from Core's start contract.

A module declares what it needs and the host has only that. In Kibana the plugin that registers the
task type hands over its own service for the same capability.

| Declare | `host` gets | In a process | In Kibana |
| --- | --- | --- | --- |
| `savedObjectTypes` | saved object types registered | Core's repository and clients; the spaces extension takes the space from the fake request | Core |
| `encryptedSavedObjectTypes` | `encryptedSavedObjects` | the real encrypted saved objects plugin, with the keys the process is sent | `hostExtensions.encryptedSavedObjects` |
| `eventLog` | `eventLog` | the writer of the event log plugin, stamped with Kibana's server UUID, flushed at exit | `hostExtensions.eventLog` |
| `taskManager` | `taskManager` | writes `task` saved objects, only for `schedulableTypes` | Task Manager's start contract |
| `uiSettings` | `uiSettings` | Core's, with the module's defaults registered | Core |
| `licensing` | `licensing` | the license read from Elasticsearch once, and feature usage | the licensing plugin |
| `settings: ['pluginId']` | `settings.pluginId` | the validated config Kibana sends | the getter passed to `registerTaskType` |
| `featureFlags` | `featureFlags` | the values Kibana evaluated for this run | Core |
| `contributions` | `contributions[key]` | what plugins export for the key | the plugins themselves |
| `taskPlugins` | `plugins[id]` | the `start` contract of each plugin | the real plugins |

`host.analytics`, `host.telemetry`, `host.security` and `host.elasticsearch` are always there.

**Telemetry is returned, not sent.** A run reports analytics events, feature usage and plugin
channels through the host. The process keeps them for that run and returns them with the result, and
the Kibana that dispatched the run reports them with its own analytics, licensing and the sinks
plugins register with `registerTaskProcessTelemetrySink(kind, sink)`.

**Config over the wire.** Kibana sends its Elasticsearch connection, the encryption keys, the
`security` settings (which carry UIAM) and the plugin configs the task type registered. Core
validates what it reads with its own schemas; certificates are written to a private temporary directory
that is removed at exit. Secrets go over the fork channel, the same trust as the Elasticsearch
credentials; never log them.

**Installs.** A run does what it would do in Kibana, and nothing a plugin's startup does. What a run
triggers (the alerts resources of a space it runs in for the first time, a signing key, the endpoint
action requests data stream) happens in the process with the plugin's own idempotent code. Startup
installs are Kibana's: Core's migrations and data streams are skipped, and a plugin's factory takes
definitions that are already installed.

### Plugin factories

A plugin that a run depends on exposes a function with explicit dependencies, used by both its own
`plugin.ts` and the process (`createMlRunServices`, `createInfraAlertingLibs`,
`createFleetRunServices`, `createRuleDataService`, `createRunTimeSecurity` ...). There is one
implementation and no copy to drift. Where something cannot exist in a process it throws a clear
"only available in Kibana" error when used.

### Declining a run

A runner may throw `DeclinedRunError` when it cannot serve this run, such as a rule that uses a
connector type the process does not know. The process answers `422`, and Kibana runs the task itself,
as it does for a `404`. Decide before the run has side effects. It is a safety net: the contributions
below register every connector type Kibana has, so it should not fire.

### Remote processes

A remote process reads the same things from its environment: `ES_URL` with `ES_API_KEY` or
`ES_USERNAME` and `ES_PASSWORD`, `PORT`, `TASK_PROCESS_TOKEN`, `ESO_ENCRYPTION_KEY` and
`ESO_DECRYPTION_ONLY_KEYS` (comma separated), `KIBANA_SERVER_UUID`, `KIBANA_BUILD_NUM`,
`KIBANA_PUBLIC_BASE_URL`, `KIBANA_SERVERLESS`, `KIBANA_DEV`, and `TASK_PROCESS_SETTINGS`, the path of a
JSON file `{ "settings": { "<pluginId>": <config> }, "uiSettingsOverrides": {} }` whose configs use the
format of `serializeSettings` (a duration is `{"__kind":"duration","ms":1000}`).

## Bundles

`node scripts/task_bundle` builds one bundle per file in `plugin.taskTypes`: Core, the plugins above
and the module. Workspace source is treated as free of import-time side effects, so a barrel costs only
what is used from it. Two traps: import leaf files (a cycle through an `export *` barrel leaves names
undefined in a bundle), and a module that reaches a plugin class through a barrel still pays for it.
Bundle size and memory are not optimized yet (about 25 to 45 MB per bundle).

### Contributions

A plugin adds what other plugins' task types need under `plugin.taskTypeContributions` in its
`kibana.jsonc`: `{ "alerting-rule-run": ["server/task_types/rule_run_contribution.ts"] }`. The file
exports `contribution`. A task type that lists the key in `contributions` gets every plugin's export:
the bundler imports them and the process hands them to the module. Stack connectors, cases and the
observability AI assistant contribute the connector types and adapters of their system actions, so a
rule module never names the plugins that add connectors.

## Alerting rule types

Every rule type is a task type module, `alerting:<ruleTypeId>`, built by `createRuleTaskType`
(`alerting/server/task_types/rule_task_type.ts`). Kibana registers it from the rule type and runs it
with the alerting plugin's services. The plugin that owns the rule type adds a module file to its
`plugin.taskTypes` that builds the same rule type from the process and runs the same `TaskRunner` with
services rebuilt from it (`task_types/standalone`): rules settings, maintenance windows, the alerts
service, an actions runtime that enqueues (and executes connectors only when the module asks), data
views, search and the locators the module lists.

```ts
// <plugin>/server/task_types/my_rule.task.ts
export const taskType = createRuleTaskType(
  {
    ruleTypeId: MY_RULE_ID,
    // The factory gets the host, the rule run runtime (read it when the rule runs, not while it is
    // built), field formats, settings and locators.
    getRuleType: ({ isServerless, host, runtime }) => getRuleType(isServerless),
  },
  { locators: [createDiscoverAppLocatorDefinition()] }
);
```

Options: `locators`, `savedObjectTypes`, `encryptedSavedObjectTypes`, `uiSettings`, `eventLogProviders`,
`settings`, `executeConnectors`, `schedulableTaskTypes`, `taskPlugins`. A plugin whose rule types read
its config calls `alerting.registerTaskProcessSettings(id, getConfig)`. Add a test with
`expectModuleToMatchRegisteredRuleType` so the module and the plugin cannot drift.

Not the same in a process: no `alert.status.changed` workflow events, usage counters or in-memory
metrics; connector authorization of the enqueue is not checked until Kibana runs the connector task;
a rule that uses a connector type or adapter the process does not know is declined; and each run is a
fresh process, so it pays for the encryption service, the license and the alerts resource checks every
time.

The distributable builds the bundles into `task_bundles/`.
