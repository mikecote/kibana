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

```yaml
xpack.task_manager.task_execution:
  max_concurrent_processes: 8       # default: xpack.task_manager.max_workers
  child_max_old_space_mb: 512       # optional
```

### Running processes in production

- **Loopback only.** A forked process listens on `127.0.0.1` and on a port the OS picks. Everything
  secret (the Elasticsearch credentials, the encryption keys, the security settings) goes over the
  fork channel (IPC), which no other process can read. Over HTTP go only the run request (the task,
  and the fake request credentials of this run) and the bearer token the supervisor generated at
  startup and sent over IPC; `/run` and `/cancel` refuse any other caller, and `/health` is the only
  open route. A remote process, which has to be reachable, listens on `HOST` (default: all addresses).
- **It ends with Kibana.** A process exits when the fork channel disconnects (Kibana was killed) and,
  as a backstop, when its parent pid changes, closing Core first (bounded to 5 s). No orphans remain
  after a `SIGKILL` of Kibana.
- **Flags.** A process does not inherit `--inspect*`/`--debug*` (the port would clash with Kibana's) or
  heap sizing flags (`--max-old-space-size` and friends, which are sized for Kibana) from `execArgv` or
  `NODE_OPTIONS`. `child_max_old_space_mb` sets the heap of each process explicitly.
- **Capacity.** At most `max_concurrent_processes` processes are held by runs at once (the default is
  `max_workers`, the most runs Kibana has in flight, so it only bites when lowered). A run past the cap is
  not queued: Kibana runs it itself and counts a `capacity` fallback. Memory is the reason for the cap; a
  process costs about 500 MB resident for a rule bundle (measured on `es_query`). Every spawn and exit logs the number of live processes at debug.
- **Shutdown.** On stop the supervisor refuses new runs, waits up to 10 s for the runs in flight (each
  stops its own process when it ends) and then stops what is left with `SIGTERM`, and `SIGKILL` after 2 s.
- **Logs.** A process writes Kibana's JSON layout (the same ECS records as `logging.appenders` with
  `layout: json`) at the lowest level Kibana's Task Manager logger writes. Kibana reads each line from the
  process's stdout and logs it again with its own logger (`plugins.taskManager.task_process`), so the
  configured layout, appenders and level filters apply, and labels each line with `task_type`, `run_id` (the
  execution id) and `child_logger` (the context inside the process, such as `plugins.alerting`). A line that
  is not a record (a crash, `stderr`) is logged as is, with the same labels. This needs no new channel and no
  copy of Kibana's logging configuration, which a process cannot see; the cost is one parse per line.
- **Counters.** `getTaskProcessStats()` on Task Manager's start contract returns the fallbacks by task type
  and reason (`declined` for a 422, `not_served` for a 404, `capacity`, `spawn_failed`, `spawn_timeout`,
  `unavailable`) and the supervisor's numbers (`live`, `active`, `max`, `spawned`, `spawnFailures`,
  `spawnTimeouts`, `capacityRejections`). Fallbacks are also in the `taskManager` usage counter as
  `taskProcessFallback:<reason>:<taskType>` and logged at warn. They are not in the health API, whose
  response schema is public; that would be its own change.

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
| `uiSettings` | `uiSettings` | Core's, with the module's `defaults` and `globalDefaults` (`registerGlobal`) registered and Kibana's `uiSettings.overrides` and `globalOverrides` applied | Core |
| `licensing` | `licensing` | the license read from Elasticsearch once; feature usage written to the saved object every node and process shares | the licensing plugin |
| `usageCounters` | `usageCounters` | the usage collection plugin's own counters service, stored when the run ends | the usage collection plugin |
| `settings: ['pluginId']` | `settings.pluginId` | the validated config Kibana sends | the getter passed to `registerTaskType` |
| `featureFlags` | `featureFlags` | the values Kibana evaluated for this run | Core |
| `contributions` | `contributions[key]` | what plugins export for the key | the plugins themselves |
| `taskPlugins` | `plugins[id]` | the `start` contract of each plugin | the real plugins |

`host.analytics`, `host.security`, `host.elasticsearch` and `host.onRunEnd` (in a process) are always there.

**A process does every side effect itself.** Kibana does nothing with a run but reschedule it, so
nothing a run produces comes back in the response, and the process finishes it before it answers (bounded
by a few seconds, so a slow endpoint cannot hold the run; a warning is logged on timeout):

- **Analytics events.** A module that lists the telemetry plugin's task plugin in `taskPlugins` (rule
  modules always do) gets Core's analytics client with the real `ElasticV3ServerShipper`, opted in as
  Kibana is, with the labels, license and cloud context Kibana's events carry. The telemetry plugin
  sends the opt-in, `sendUsageTo` and labels (`getTaskProcessSettings`); alerting adds the license and
  the cloud deployment. If Kibana has no opt-in, nothing ships, exactly as in Kibana. Events leave
  through the shipper's `flush`, and Core's shutdown flushes the rest.
- **Usage counters.** `host.usageCounters.getUsageCounter(domainId)` is the usage collection plugin's
  `UsageCountersService`: the same `usage-counter` saved objects, one per counter and day, stored at
  the end of the run instead of on the interval. The daily clean-up stays with Kibana.
- **Feature usage.** The licensing plugin keeps when each feature was last used in a hidden saved
  object (`licensing-feature-usage`, one per feature) that every node and process writes, and
  `/api/licensing/feature_usage` and `getLastUsages()` read it merged with the node's memory.
  `host.licensing.featureUsage.notifyUsage` writes through the same store.
- **Anything else with a queue.** `host.onRunEnd(flusher)` registers what has to finish before the
  process answers. Security telemetry builds its own sender from a snapshot of Kibana's telemetry
  settings (opt-in, endpoint, cluster and license) and flushes its queue there.

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
below register every connector type Kibana has, and the parity guard below proves it, so it should not
fire. Kibana logs every fallback with its reason (`TaskProcessFallbackCounter`, which also counts them in
Task Manager's usage counter as `taskProcessFallback:<reason>:<taskType>`), so a decline can be alarmed on.

### Parity with Kibana

A module can prove that its process registered what Kibana did. `parity: [{ kind, getIds(host) }]` on the
module says which ids the process registered for a kind (rule modules have `connectorTypes` and
`connectorAdapters`); `parity: { kind: () => ids }` in the options of `registerTaskType` says which ids Kibana
has. Kibana reads its side for every dispatch (a plugin can register a connector type at any time) and sends it
in `init.parity`; the process compares once, before its first run, and when Kibana has ids it lacks it logs a
warning that names them and declines every run. The per-rule check of `declineIfUnsupported` stays: it only
looks at the connector types the rule uses.

### Settings Kibana sends for every dispatch

Besides the plugin configs in `settings`, Kibana reads at each dispatch what changes while it runs: its final
in-memory connectors (`settings.actionsConnectors`: preconfigured connectors that did not conflict with a saved
one, dynamic ones other plugins registered, system connectors, with their flags; it holds secrets, so never log
it), its `uiSettings.overrides` and `uiSettings.globalOverrides` (read from Core's ui settings client, which
reports the overridden settings) and its `server.publicBaseUrl` exactly as Core has it, with `server.basePath`
only so that Core accepts a public base URL with a path. A process that has no public base URL builds no links,
as Kibana does not.

### Remote processes

A remote process reads the same things from its environment: `ES_URL` with `ES_API_KEY` or
`ES_USERNAME` and `ES_PASSWORD`, `PORT`, `TASK_PROCESS_TOKEN`, `ESO_ENCRYPTION_KEY` and
`ESO_DECRYPTION_ONLY_KEYS` (comma separated), `KIBANA_SERVER_UUID`, `KIBANA_BUILD_NUM`,
`KIBANA_PUBLIC_BASE_URL` (leave it unset when Kibana has none), `KIBANA_BASE_PATH`, `KIBANA_SERVERLESS`,
`KIBANA_DEV`, and `TASK_PROCESS_SETTINGS`, the path of a JSON file `{ "settings": { "<pluginId>": <config> },
"uiSettingsOverrides": {}, "uiSettingsGlobalOverrides": {}, "parity": [{ "kind": "...", "ids": [] }] }` whose
configs use the format of `serializeSettings` (a duration is `{"__kind":"duration","ms":1000}`). A remote
process is not sent the settings Kibana reads per dispatch, so it skips the parity check unless the file has `parity`.

## Bundles

`node scripts/task_bundle` builds one bundle per file in `plugin.taskTypes`: Core, the plugins above
and the module. Workspace source is treated as free of import-time side effects, so a barrel costs only
what is used from it. Two traps: import leaf files (a cycle through an `export *` barrel leaves names
undefined in a bundle), and a module that reaches a plugin class through a barrel still pays for it.
Bundle size and memory are not optimized yet (about 25 to 45 MB per bundle).

### Distributable

The `BuildTaskBundles` task of `node scripts/build` (after `BuildBundles`, before `InstallDependencies`) writes one
bundle per `plugin.taskTypes` entry and `manifest.json` to `<build>/task_bundles`, and the archive copy
step carries the directory into every platform folder. In a distributable `bundle_dir` defaults to
`<install dir>/task_bundles` (`REPO_ROOT` is the install dir there; from a repository checkout it is
`target/task_bundles`, which is where `node scripts/task_bundle` writes), and the manifest has
`{ kibanaVersion, bundles: { <name>: { file, taskType, bytes } } }`, which is what the supervisor reads.

Verified by running the task function against a temporary build directory (48 bundles, 1.4 GB, 29 minutes
with four builds at a time) and booting the `es_query` bundle, copied alone with its manifest to a directory
outside the repository, with the supervisor against a real Elasticsearch: Core and the module started and
`/health` served `alerting:.es-query`.

- **Externals.** `re2` and `canvas` are external. `re2` is no longer a dependency of Kibana (`re2js` is
  JavaScript, so it is bundled) and no bundle requires it. No bundle needs a native module: `lmdb`, `sharp`
  and `@parcel/watcher` are not in any bundle, and the `.node` files that are referenced
  (`zstd`, `kerberos`, `snappy`) are optional requires inside `try`/`catch` of MongoDB and AWS clients that
  Kibana's own `node_modules` would serve. If a native module is ever needed, add it to `EXTERNALS` and it
  resolves from the distributable's `node_modules`, since a bundle sits at `<install dir>/task_bundles`.
- **Nothing reads the source tree.** `@kbn/repo-info` is replaced with a stub that answers with the working
  directory, so a bundle never walks up to find a repository; a task process does not read the paths
  `@kbn/utils` derives from it. The remaining `__dirname` and `readFileSync` uses are libraries' own
  (pino worker threads, `source-map`'s `mappings.wasm`) and are on paths a run does not take.
- **Cost.** Every bundle carries Core and the plugins it needs: 28 to 31 MB each, so 1.4 GB for all 48 task
  types, and a build of about half an hour. Bundle splitting (one shared Core) is the way to cut both, and
  is not done.
- **Not covered here.** The full archive build (`node scripts/build`), and Windows.

### Contributions

A plugin adds what other plugins' task types need under `plugin.taskTypeContributions` in its
`kibana.jsonc`: `{ "alerting-rule-run": ["server/task_types/rule_run_contribution.ts"] }`. The file
exports `contribution`. A task type that lists the key in `contributions` gets every plugin's export:
the bundler imports them and the process hands them to the module. Stack connectors, cases and the
observability AI assistant contribute the connector types and adapters of their system actions, so a
rule module never names the plugins that add connectors.

## Making a plugin's services available to other plugins' tasks

A task process has no plugin lifecycle, so a service that another plugin's task needs has to be built
from explicit inputs. These are the steps, in the order most plugins need them.

1. **Extract a run-time factory with explicit dependencies.** Move the construction of the service out
   of `plugin.ts` into a function in the plugin's `server/` that takes what it needs as arguments
   (clients, the license observable, config, logger) and not `getStartServices`, plugin class state or
   module globals. `plugin.ts` calls the same function with Kibana's services, so there is one
   implementation. Examples: `createMlRunServices`, `createFleetRunServices`, `createRuleDataService`,
   `createInferenceRunServices`, `createRunTimeSecurity`. Read services lazily when they are used, not
   while the factory runs, because the process builds things in a different order than Kibana.
2. **Throw for what cannot exist.** If a part needs something only Kibana has (HTTP routes, the
   session, a long-lived poller), make it throw "only available in Kibana" when used, so a path that
   reaches it fails loudly. Do not return an empty object that silently does nothing.
3. **Do not install anything at startup.** Index, template and data stream creation belongs to Kibana.
   Take already-installed definitions (build a client from its definition, skip mapping updates on
   read). Installs a run itself triggers in Kibana, such as an alerts index for a new space, stay as
   they are and use the plugin's own idempotent code.
4. **Send the config the factory reads.** Register it with `alerting.registerTaskProcessSettings(id,
   () => config)` in `setup` and list the id in the module's `settings`. Send only what is read, in a
   form `serializeSettings` handles (plain values, durations, byte sizes and dates; no functions,
   `Map`, `Set` or `RegExp`), and read it as `host.settings[id]`. A plugin that cannot depend on
   alerting exposes a `getTaskProcessSettings()` on its setup contract and a plugin that can (alerting
   itself does this for `security`) registers it. Task Manager sends its own settings.
5. **Declare what the task reads of Core.** On the module or `createRuleTaskType` options: saved object
   types (`savedObjectTypes`), encrypted saved objects (`encryptedSavedObjectTypes`), event log
   providers, ui settings defaults, feature flags, the task types it schedules. Types the plugin owns
   should come from the same code that registers them in `setup` (a `get<Plugin>SavedObjectTypes()`
   that runs the real registration with a collecting registrar), so the process and Kibana cannot
   disagree.
6. **If Core must know about it, ship a task plugin.** Things that register with Core at `setup`, such
   as the security delegate, need a plugin: add `server/task_plugin.ts` exporting a `StaticPlugin`
   (`manifest` and `definition` with an optional `config`), keep it free of routes and the plugin class,
   and have the module list it in `taskPlugins`. Its `start` contract is what the runner reads as
   `host.plugins[id]`.
7. **If other task types need to register something with your plugin, take contributions.** Define the
   shape in the consuming plugin, add a key to the task type's `contributions` and have contributing
   plugins list a file under `plugin.taskTypeContributions` in their `kibana.jsonc` that exports
   `contribution`. Rule runs use `alerting-rule-run` (see `RuleRunContribution`).
8. **Do the side effects in the run.** Use `host.analytics.reportEvent`, `host.usageCounters` and
   `host.licensing.featureUsage` rather than the services directly: in a process they are the real
   shipper, counters and store, and the process flushes them before it answers. A plugin with a queue
   of its own builds it from explicit dependencies and a snapshot of what it reads from Kibana (send the
   snapshot as a setting) and registers its flush with `host.onRunEnd`. Nothing is returned to Kibana.
9. **Keep the bundle clean.** Import leaf files, not barrels. A cycle through an `export *` barrel
   leaves names undefined inside a bundle. Do not import a plugin class (`server/plugin.ts`); use
   `node scripts/task_bundle --name <bundle>` and the bundle hygiene test (`es_query_bundle.test.ts`)
   to check what ends up inside.
10. **Test it three ways.** A unit test of the factory with the plugin's existing mocks; a parity test
    (`expectModuleToMatchRegisteredRuleType`) for each rule type module; and, for a new family, a real
    run: build the bundle, run it through the supervisor against a real Elasticsearch and assert the
    run was not declined and wrote what Kibana would (see the tests named `*_task_process.test.ts`).
    `node scripts/task_bundle_bench` shows what the addition costs in startup time and memory.

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

A run in a process does what it does in Kibana; Kibana starts it and processes its end result (the
reschedule, the task state, the retries). What differs, and why:

- **`alert.status.changed` workflow events.** The batch is built by the same functions as in Kibana
  (`alert_status_changed_emitter.ts`), before the action scheduler clears the snapshot of the alerts, and is
  sent by the process before it answers, with the workflows client built from the request of the run. A
  plugin that wants the events contributes to `alerting-rule-run`: `register` calls
  `alerting.enableAlertStatusChanged({ isEnabled, featureFlags })` as the plugin does in Kibana (the flags it
  reads go in `declares.featureFlags`; Kibana evaluates them for each dispatch and sends them as
  `host.featureFlags`), and `getWorkflowsClient(request, context)` returns what `workflowsExtensions.getClient`
  returns. Without a contribution that provides the client, a run sends no events. This branch has no such
  contribution: the workflows plugins have to add it.
- **In-memory metrics.** The `node_rules` collector reads Kibana's counters, so Kibana counts what its processes
  served from the end of the run (`observeRemoteRun`): a result is an execution, a result with a
  `taskRunError` is also a failure (it is the same condition as the outcome of `TaskRunner`), a run Kibana
  cancels for its timeout is a timeout and no execution. A run Kibana serves itself (a fallback) counts itself.
- **Settings Kibana decides.** `settings.alertingRun` carries what alerting learns from the plugins around
  it: whether the maintenance windows plugin is enabled (without it no window applies), the data views'
  `scriptedFieldsEnabled` (off by default in serverless), and the `data.search` config, the Elasticsearch
  timeouts and whether rollups are enabled. ES|QL searches read the license, as in Kibana. A plugin that
  reads feature flags in a run registers them with `alerting.registerTaskProcessFeatureFlags`.
- **License feature usage** is reported by the process for the rule types and connector types that need a
  license, to the store every node shares.
- **Not reproduced.** OpenTelemetry counters (`kibana.alerting.rule_run.count`, the connector counters): a
  process has no meter provider, Kibana's is created by its command line from `telemetry.metrics`, and a
  short-lived process cannot export the same series (cumulative counters of one resource from many
  processes overwrite each other, and Prometheus cannot scrape them). A rule that uses a connector type or
  adapter the process does not know, or a workflow rule whose executions are stored where the process cannot
  store them, is declined, and each run is a fresh process, so it pays for the encryption service, the license
  and the alerts resource checks every time.

### Testing a rule type in a process

`alerting/server/task_types/testing/rule_process_harness.ts` is the harness of every real run of a rule
type (`*_task_process.test.ts` next to the plugin that owns the rule type). `startRuleProcessHarness({ rules:
[{ taskType, bundle }] })` boots a test Elasticsearch with a trial license, builds the bundles once (four at a
time), sends the process every setting Kibana sends (alerting, actions, security with the license, `alertingRun`,
`cases`, `stackConnectors`, the final connectors and the parity lists; more with `settings`), and seeds rules,
connectors and API keys as Kibana stores them. `run(ruleId, ruleTypeId)` goes through `RemoteTaskRunner` and fails
when the run was declined; `runInProcess` runs the same rule in the test process, as Kibana's runtime does,
and `runBoth` compares the two. `createUserWithPrivileges` registers Kibana privileges in Elasticsearch, which a
process does not, so a rule can be created by a user who may or may not execute connectors or read a data view.
`rule_process_parity.test.ts` (stack alerts) holds the behaviour tests: enqueue authorization, saved object
privileges of the executor, timeout and cancel (and the in-memory metrics observer), a forked run against one in
the test process, and `alert.status.changed` with a fake workflows client contribution.

The distributable builds the bundles into `task_bundles/`.
