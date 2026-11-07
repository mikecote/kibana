# Task type modules

A task type module is one file that holds a Task Manager task type: its definition and its runner.
Kibana registers it as it does any task type. The same file can also be bundled and run in a
process of its own, with Kibana still claiming, validating, timing out and rescheduling the task.

```ts
// <plugin>/server/task_types/my_task.task.ts
import { defineTaskType } from '@kbn/task-manager-plugin/server';

export const taskType = defineTaskType({
  type: 'myPlugin:my_task',
  title: 'My task', // everything `registerTaskDefinitions` takes, but the runner
  timeout: '1m',
  savedObjectTypes: [myType], // only if the runner uses saved objects
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
  mode: in_process # default: in Kibana's process
```

**`child_process`.** Each run forks the task type's bundle, sends it Kibana's own Elasticsearch
connection over the fork channel, runs the task in it and stops it when the run ends. If the process
cannot be started, Task Manager retries process execution according to the task retry policy.
A process-routed task never runs inside Kibana as a fallback. Required bundles are validated at startup.

```yaml
xpack.task_manager.task_execution:
  mode: child_process
  bundle_dir: target/task_bundles # optional; the distributable uses its own task_bundles
```

Build the bundles with `node scripts/task_bundle` (the distributable builds them for you).

For the PoC, process reuse is opt-in. Each child still runs one task at a time, but may serve
subsequent runs of the same task type after successful completion, flushing, and cleanup:

```yaml
xpack.task_manager.task_execution:
  mode: child_process
  reuse:
    enabled: true # default: false
    idle_timeout_ms: 30000 # retain a child for up to 30 seconds between runs
    max_age_ms: 300000 # retire after five minutes; does not interrupt an active run
    max_runs: 100 # retire after this many executions
    max_idle_processes: 10 # global cap across all task types, in addition to active processes
```

Omitting `reuse` retains a fresh process per run. Reuse requires rebuilt bundles: older bundles do
not report successful cleanup and are retired after each run. Changes to startup settings (including
Elasticsearch credentials and encryption keys) retire incompatible idle children before dispatch.
Run credentials, feature flags, and task state are supplied for each execution. Cancellation sends
`SIGKILL` after the task type's optional cancellation grace period, and failed runs or failed cleanup retire the process. Process memory and module
state can survive between successful runs; this mode preserves isolation from Kibana but not a clean
process for every execution. Reused children log `Reusing process <pid> for task <type>` at info.

```yaml
xpack.task_manager.task_execution:
  max_concurrent_processes: 8 # default: xpack.task_manager.max_workers
  child_max_old_space_mb: 512 # optional
  child_max_semi_space_mb: 2 # optional, the default: the young generation of each process
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
  `NODE_OPTIONS`. `child_max_old_space_mb` sets the heap of each process explicitly. Every process starts
  with `--max-semi-space-size=2` (`child_max_semi_space_mb`): Node's default lets the young generation
  grow to 128 MB resident, which a process that lives for one run never needs. Measured on idle
  processes, 2 MB takes 63 MB (Task Manager floor), 117 MB (`es_query`) and 110 MB (security rules) off the
  resident memory with the same startup time, at about 7% more CPU in allocation-heavy work (4 MB: about 2%).
- **Capacity.** At most `max_concurrent_processes` processes are held by runs at once (the default is
  `max_workers`, the most runs Kibana has in flight, so it only bites when lowered). A run past the cap is
  retried by Task Manager and counted as a `capacity` dispatch failure. Memory is the reason for the cap; a
  process's memory depends on its task type and settings; the paired measurements below cover startup,
  idle memory and the first real task. Every spawn and exit logs the number of live processes at debug.
- **Shutdown.** On stop the supervisor refuses new runs, waits up to 10 s for the runs in flight (each
  stops its own process when it ends) and then stops what is left with `SIGTERM`, and `SIGKILL` after 2 s.
- **Cancellation.** Task types may declare `cancelGracePeriodMs`. Workflow tasks allow five seconds
  for the execution to persist cancellation and clean up before forced termination. The cancellation
  endpoint acknowledges only after the execution finishes. Other task types retain immediate
  `SIGKILL`; an unresponsive workflow process is killed when its grace period expires. Cancelled
  processes are always retired. Normal completion uses `SIGTERM` unless reuse is enabled.
- **Logs.** A process writes Kibana's JSON layout (the same ECS records as `logging.appenders` with
  `layout: json`) at the lowest level Kibana's Task Manager logger writes. Kibana reads each line from the
  process's stdout and logs it again with its own logger (`plugins.taskManager.task_process`), so the
  configured layout, appenders and level filters apply, and labels each line with `task_type`, `run_id` (the
  execution id) and `child_logger` (the context inside the process, such as `plugins.alerting`). A line that
  is not a record (a crash, `stderr`) is logged as is, with the same labels. This needs no new channel and no
  copy of Kibana's logging configuration, which a process cannot see; the cost is one parse per line.
- **Counters.** `getTaskProcessStats()` on Task Manager's start contract returns `dispatchFailures` by task type
  and reason (`declined` for a 422, `not_served` for a 404, `capacity`, `spawn_failed`, `spawn_timeout`,
  `unavailable`) and the supervisor's numbers (`live`, `active`, `max`, `spawned`, `spawnFailures`,
  `spawnTimeouts`, `capacityRejections`). Dispatch failures are also in the `taskManager` usage counter as
  `taskProcessDispatchFailure:<reason>:<taskType>` and logged at warn. They are not in the health API, whose
  response schema is public; that would be its own change.

**`remote`.** Runs go to an authenticated task worker supervisor. It serves the task types in its
bundle manifest and starts or reuses an isolated execution process for each dispatch. Both modes use
the same serialized initialization snapshot, including current connectors, registration ids, encryption
keys, UI overrides and plugin settings. Credentials and evaluated feature flags belong to each run.

```yaml
xpack.task_manager.task_execution:
  mode: remote
  remote:
    url: http://localhost:4100
    token: secret # matches the worker's required TASK_PROCESS_TOKEN
```

```sh
PORT=4100 TASK_PROCESS_TOKEN=secret node scripts/task_worker
```

The worker reads `TASK_PROCESS_BUNDLE_DIR` (default `target/task_bundles`),
`TASK_PROCESS_MAX_CONCURRENT` (default `4`), `PORT` (default `5602`) and `HOST` (default `127.0.0.1`).
Set `TASK_PROCESS_REUSE=true` to retain compatible workers for up to 100 runs, five minutes of age,
or 30 seconds idle, with at most four idle workers. Off-host deployments terminate TLS in front of
the authenticated endpoint because dispatch snapshots carry secrets. Elasticsearch credentials and
Kibana settings come from the dispatch; a static settings file is not needed.

Missing task types and incompatible deployments fail explicitly. Capacity and startup failures remain
on the process route. Existing standalone bundle endpoints are useful for development, but remote
mode now targets the supervisor so every dispatch receives its current configuration.

## What a process is

A task process boots Core's `TaskRoot` with a fixed set of task plugins. It shares Core's configuration,
logging, Elasticsearch, saved objects, UI settings, analytics, security, status and plugin lifecycle
implementations. It does not construct inbound HTTP servers, rendering, Core apps or browser assets.
Index migration orchestration is skipped; document migrations, mappings, serialization and repository
extensions remain available. Outbound HTTP uses Core's real self client, including base paths and UIAM.

Task plugins implement `TaskPlugin` and export a `taskPlugin` initializer. `TaskCoreSetup` and
`TaskCoreStart` expose the services available in this composition, so task plugins cannot accidentally
depend on web setup contracts. The encrypted saved objects plugin shares its runtime initialization
with normal Kibana and leaves key-rotation routes out of task startup.

The plugins are Task Manager (it collects the task definitions), the encrypted saved objects plugin
when the module declares encrypted types, any `taskPlugins` the module brings (such as the security
plugin's slim task plugin, which registers Core's security delegate so API keys, UIAM, privilege
checks and audit are the security plugin's), and one plugin that adapts the module: it registers what
the module declares and gives the runner its `host` from Core's start contract.

A module declares what it needs and the host has only that. In Kibana the plugin that registers the
task type hands over its own service for the same capability.

| Declare                     | `host` gets                   | In a process                                                                                                                                              | In Kibana                               |
| --------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `savedObjectTypes`          | saved object types registered | Core's repository and clients; the spaces extension takes the space from the fake request                                                                 | Core                                    |
| `encryptedSavedObjectTypes` | `encryptedSavedObjects`       | the real encrypted saved objects plugin, with the keys the process is sent                                                                                | `hostExtensions.encryptedSavedObjects`  |
| `eventLog`                  | `eventLog`                    | the native event-log writer, stamped with Kibana's server UUID, flushed before each run answers                                                                    | `hostExtensions.eventLog`               |
| `taskManager`               | `taskManager`                 | writes `task` saved objects, only for `schedulableTypes`                                                                                                  | Task Manager's start contract           |
| `uiSettings`                | `uiSettings`                  | Core's, with the module's `defaults` and `globalDefaults` (`registerGlobal`) registered and Kibana's `uiSettings.overrides` and `globalOverrides` applied | Core                                    |
| `licensing`                 | `licensing`                   | the license read from Elasticsearch once; feature usage written to the saved object every node and process shares                                         | the licensing plugin                    |
| `usageCounters`             | `usageCounters`               | the usage collection plugin's own counters service, stored when the run ends                                                                              | the usage collection plugin             |
| `settings: ['pluginId']`    | `settings.pluginId`           | the validated config Kibana sends                                                                                                                         | the getter passed to `registerTaskType` |
| `featureFlags`              | `featureFlags`                | the values Kibana evaluated for this run                                                                                                                  | Core                                    |
| `contributions`             | `contributions[key]`          | what plugins export for the key                                                                                                                           | the plugins themselves                  |
| `taskPlugins`               | `plugins[id]`                 | the `start` contract of each plugin                                                                                                                       | the real plugins                        |

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
- **Connector execution logs.** The Actions client uses the native Event Log reader with the
  execution request's saved-object authorization and space. The writer drains queued batches before
  replying and remains open for later runs of a reused worker.
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
implementation and no copy to drift. Any execution dependency missing from a process is a parity
defect to complete before the affected capability is enabled.

### Capability failures

The existing `DeclinedRunError` reports a capability mismatch as `422`. Task Manager treats it and
an unserved task type (`404`) as an explicit failure without local execution. Process dispatch failures
are logged and counted by `TaskProcessDispatchFailureCounter`, including the reason returned by the
process. A capability mismatch is a parity defect to fix before enabling the affected feature.

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

The remote supervisor receives the same versioned dispatch snapshot as child-process mode and
passes initialization secrets to its execution child over IPC. Compatible snapshots permit sequential
reuse; changed plugin settings, registration ids, UI overrides or credentials retire incompatible idle
children. Evaluated feature flags and run identities are supplied for each execution. A worker requires
its bearer token on execution and cancellation requests and validates the dispatch version and deadline.

## Bundles

`node scripts/task_bundle` builds one bundle per file in `plugin.taskTypes`: Core, the plugins above
and the module. Workspace source is treated as free of import-time side effects, so a barrel costs only
what is used from it. Two traps: import leaf files (a cycle through an `export *` barrel leaves names
undefined in a bundle), and a module that reaches a plugin class through a barrel still pays for it.
Each entry is an ESM `.mjs` file with chunks under `chunks/<entry>/`. Connector definitions retain
metadata, schemas and validation at startup; services and SDKs load asynchronously when execution
needs them. Response-action implementations use the same boundary. Code splitting keeps those
implementations out of the enqueue-only startup graph. CommonJS dependencies use Node's
`createRequire` compatibility bridge. Every generated JavaScript file receives the Latin-1 transform.

### Distributable

The `BuildTaskBundles` task of `node scripts/build` (after `BuildBundles`, before `InstallDependencies`) writes one
entry and its chunks per `plugin.taskTypes` entry and `manifest.json` to `<build>/task_bundles`, and the archive copy
step carries the directory into every platform folder. In a distributable `bundle_dir` defaults to
`<install dir>/task_bundles` (`REPO_ROOT` is the install dir there; from a repository checkout it is
`target/task_bundles`, which is where `node scripts/task_bundle` writes), and the manifest has
`{ kibanaVersion, bundles: { <name>: { file, files, taskType, bytes, startupBytes } } }`.
`bytes` counts all generated JavaScript; `startupBytes` counts the entry and its static imports.
`files` lists the entry's complete output, including chunks and source maps. Copy the entire
`task_bundles` directory when moving a build; copying the entry alone omits deferred implementations.

The bundle hygiene integration test checks both `.es-query` and detection rules for EUI, accidental
plugin classes, exporter management code, tokenizer tables and connector executor SDKs in static
startup imports. Runtime integration tests exercise task processes against Elasticsearch.
Set `KBN_TASK_BUNDLE_TEST_DIR` to a freshly built bundle directory to run rule-process integration
tests against those packaged artifacts. The harness copies the directory, including chunks, and
requires every selected entry to exist; without the setting it builds the entries from source.

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
- **Cost.** Entries share chunks within a task type; Core is still duplicated between task types.
  Artifact size includes deferred code and must be measured separately from startup memory.
- **Not covered here.** The full archive build (`node scripts/build`), and Windows.

### Memory measurements

Measured on 2026-11-06 with Node 24.21.0 and `--max-semi-space-size=2`. Each cell is baseline → candidate,
using the median of five interleaved runs per variant. The baseline includes PR #10's Latin-1 fix.
Both variants use the same validated settings and an active trial security license. These real-rule
fixtures differ from the minimal settings used for earlier startup-only measurements.

| Platform    | Task             | Startup (ms) | Idle RSS (MiB) | Idle heap used (MiB) | Peak RSS through first task (MiB) |
| ----------- | ---------------- | ------------ | -------------- | -------------------- | --------------------------------- |
| macOS ARM64 | Task Manager     | 504 → 337    | 200 → 158      | 87 → 49              | 201 → 158                         |
| macOS ARM64 | `.es-query`      | 880 → 676    | 344 → 266      | 173 → 114            | 365 → 267                         |
| macOS ARM64 | `siem.queryRule` | 1363 → 870   | 483 → 312      | 263 → 156            | 495 → 327                         |
| Linux ARM64 | Task Manager     | 575 → 381    | 181 → 142      | 86 → 49              | 181 → 142                         |
| Linux ARM64 | `.es-query`      | 1065 → 805   | 301 → 235      | 150 → 115            | 314 → 238                         |
| Linux ARM64 | `siem.queryRule` | 1674 → 1036  | 394 → 276      | 247 → 153            | 419 → 291                         |

Linux used `node:24.21.0-bookworm-slim` containers with a 1 GiB memory limit and two CPUs. Each run
started a fresh process and executed a real task against Elasticsearch; rule samples used fresh
rule IDs. All 60 runs succeeded. Peak RSS combines lifetime maximum RSS with observed RSS samples.
The bundles and their chunks ran in the containers without the repository or `node_modules`.

`node scripts/task_bundle_bench --json <file>` also records heap capacity and external memory.
Pass `--settings <settings.json>` for validated plugin settings and `--run <request.json>` for the
first task's wire request. The benchmark's memory probe is not included in distributable bundles.

### Contributions

A plugin adds what other plugins' task types need under `plugin.taskTypeContributions` in its
`kibana.jsonc`: `{ "alerting-rule-run": ["server/task_types/rule_run_contribution.ts"] }`. The file
exports `contribution`. A task type that lists the key in `contributions` gets every plugin's export:
the bundler imports them and the process hands them to the module. Stack connectors, cases and the
observability AI assistant contribute the connector types and adapters of their system actions, so a
rule module never names the plugins that add connectors. The workflow task types take two more keys:
`workflow-steps` (steps and triggers) and `agent-builder` (what plugins register with agent builder's
registries, see "Agent builder in a process").

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
2. **Complete every execution dependency.** Extract the shared runtime service, contribute executable
   registrations, and snapshot current metadata from Kibana. Keep HTTP route installation and
   long-lived pollers in Kibana. Missing capabilities must fail explicitly while being completed;
   throwing placeholders and silent no-ops do not establish parity.
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
  cancels for its timeout is a timeout and no execution. An intentionally local run counts itself.
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
  store them, fails explicitly. Fresh workers pay for the encryption service, license and alerts resource
  checks at startup. Reused workers retain Core while rebuilding execution services for each run.

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

Every `alerting:*` task type has a real run in the test of its plugin. Each test seeds what
its executor reads (indices and documents, saved objects such as data views, SLOs, monitors and exception lists, machine
learning jobs and results), asserts that the run was served by the process (never declined), wrote its alerts and a
successful `execute` event, and equals the same rule run in the test process (`runBoth`: alerts, events, state):

| Plugin                  | Test (`server/integration_tests/`)                                                   | Rule types                                                                                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| stack alerts            | `es_query_task_process`, `stack_alerts_task_process`, `rule_process_parity`          | es query, index threshold, tracking containment                                                                                                                                                 |
| stack monitoring        | `monitoring_rules_task_process`                                                      | the 14 monitoring rule types                                                                                                                                                                    |
| transform, data quality | `transform_health_task_process`, `degraded_docs_task_process`                        | transform health, degraded docs                                                                                                                                                                 |
| ML                      | `anomaly_detection_alert_task_process`, `anomaly_detection_jobs_health_task_process` | anomaly detection, jobs health                                                                                                                                                                  |
| APM                     | `apm_rules_task_process`                                                             | error count, transaction duration, transaction error rate, anomaly                                                                                                                              |
| infra                   | `infra_rules_task_process`                                                           | metric threshold, inventory, log threshold                                                                                                                                                      |
| observability           | `custom_threshold_task_process`                                                      | custom threshold                                                                                                                                                                                |
| SLO                     | `slo_burn_rate_task_process`                                                         | burn rate                                                                                                                                                                                       |
| Synthetics, uptime      | `synthetics_rules_task_process`, `uptime_rules_task_process`                         | monitor status and TLS of both, uptime TLS legacy and duration anomaly                                                                                                                          |
| security solution       | `security_rules_task_process` (`server/task_types/integration_tests`)                | query (with exceptions and a response action that schedules the isolation of an Elastic Defend host), saved query, EQL, ES\|QL, threshold, new terms, indicator match, ML, legacy notifications |
| elastic assistant       | `attack_discovery_task_process`                                                      | attack discovery                                                                                                                                                                                |

### Running in a real Kibana (Scout)

The jest tests above do not boot the Kibana plugins. Three Scout config sets (stateful, API tests only) do,
with `xpack.task_manager.task_execution.mode: child_process`, `bundle_dir` set to bundles built when the config
loads (only `es_query` and `index_threshold`, about 35 s each; `TASK_PROCESSES_REBUILD=true` builds them again)
and `max_concurrent_processes: 2`. Kibana's log goes also to `target/task_processes_scout/kibana.log` as JSON
records, with Task Manager at debug, so the tests can see where each run happened.

| Config set (`kbn-scout/src/servers/configs/config_sets/`) | Tests (`task_manager/test/`)             | Proves                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `task_processes`                                          | `scout_task_processes`                   | an es query rule runs in a process (process started, lines of the process logged by Kibana with `task_type`, `run_id` and `child_logger`), writes its alert, and its server log action runs in Kibana; a webhook connector with secrets is used by an action; the extra runs past the cap retry in a process (`capacity`) and every rule completes; a run that Kibana cancels (timeout of 1 s for index threshold) leaves no process |
| `task_processes_unknown_connector`                        | `scout_task_processes_unknown_connector` | with a plugin that registers connector types no bundle knows (the parity check), the process declines and the rules fail (`declined`)                                                                                                                                                                                                                                                                                                |
| `task_processes_es_tls`                                   | `scout_task_processes_es_tls`            | the same over Elasticsearch with TLS, reached as `kibana_system` with the CA of the cluster                                                                                                                                                                                                                                                                                                                                          |

```
node scripts/scout.js start-server --arch stateful --domain classic --serverConfigSet task_processes
node scripts/playwright test --config x-pack/platform/plugins/shared/task_manager/test/scout_task_processes/api/playwright.config.ts --project local
```

Not covered: a service account token to Elasticsearch (`elasticsearch.serviceAccountToken`; the token has to
exist before Kibana starts), serverless (no serverless config set for it yet), and a Kibana that is killed while a
process is running (the jest tests of the supervisor cover it).

The distributable builds the bundles into `task_bundles/`.

## Workflows

`workflow:run`, `workflow:resume` and `workflow:scheduled` (`workflows_execution_engine/server/task_types`)
are modules too. The engine's run-time is `createWorkflowRuntime(deps)`, built with explicit
dependencies: Kibana's plugin builds it from its services and a process builds it from its host
(`task_types/process_runtime.ts`). Kibana registers the three modules with `registerTaskType` and hands
the same module code the engine's runtime as `hostExtensions.plugins`, so a module reads
`host.plugins.workflowsExecutionEngine.runtime` in both.

What a workflow run needs beyond a rule run, and where it comes from in a process:

- **Calls to Kibana.** `host.http` is Core's self client aimed at the Kibana that dispatched the run:
  Kibana sends the address where a process reaches it (`kibanaUrl`) and `server.basePath` in `init`.
  `callKibanaApi` and `kibana.*` steps use it with the credential of the run. Links (the `kibanaUrl`
  template variable, execution and approval links, rule URLs) are built from Kibana's own
  `server.publicBaseUrl`, which a process gets raw, so they are what Kibana builds.
- **Task Manager.** `host.taskManager` has `schedule`, `bulkSchedule`, `get`, `bulkGet`, `fetch`, `remove`,
  `removeIfExists`, `bulkRemove`, `runSoon` and `ensureScheduled`, written over the same `task` saved
  objects as `TaskStore`, including the invalidation of the API keys of removed tasks. `runSoon` sets
  `runAt` to now and Kibana's claim cycle picks it up: there is no nudge from a process.
- **Parking.** A wait over five seconds, a wait for input or approval and a sync child workflow park the
  run and schedule a `workflow:resume` task; a second process finishes it.
- **Data streams.** Clients are built with `DataStreamClient.fromDefinition` over the engine's shared
  definitions: nothing is installed.
- **Service accounts.** A workflow with `settings.run_as` runs in the process as in Kibana. The security task
  plugin builds the plugin's own `ServiceAccountsService` from explicit dependencies: Kibana sends
  `serviceAccounts.enabled` and `requestLifetime`, the cloud project context (organization, project and
  project type, for UIAM) and, with UIAM, the contents of the mTLS certificate, key and certificate
  authorities (not their paths, so that a remote process can connect). The two hidden saved object types
  (workload bindings, credentials) are registered by the plugin's own functions, and the service needs the
  encrypted saved objects plugin, which a module gets by declaring encrypted saved object types (the
  workflows module does). The engine's task plugin registers the `workflow` workload type and hands
  `core.security.serviceAccounts` to the runtime, because Core scopes the workload methods to the plugin
  that registered the type. Both backends are served: Elasticsearch service accounts (the credential is
  read and decrypted in the process) and UIAM (the process exchanges the account for a token itself). Without
  the encrypted saved objects plugin or with `serviceAccounts.enabled: false`, `canRunAs()` is false and the
  workflow is declined.
- **Metering.** The process reports the usage record itself. Kibana sends the Usage API connection (URL
  and TLS, setting `workflowsUsageApi`, only when it reports metering), the process builds the same
  `WorkflowsMeteringService` over the usage API's own `UsageReportingService` (the same retries, the same
  deduplicating record id, the same error log when the endpoint is down) and flushes it with
  `host.onRunEnd` before it answers. Without a connection, nothing is metered, as in Kibana.
- **Side effects.** Analytics events (the telemetry task plugin, the event types of the engine, the
  connectors and every step contribution's `declares.analyticsEventTypes`) and usage counters
  (`usageCounters: true`, such as the cases counter) are the process's own; nothing is returned to Kibana.
  A run's answer holds the result and nothing else, and Kibana only reschedules.
- **Connector steps.** The actions executor is initialized as for attack discovery, with the connector
  types of the `alerting-rule-run` contributions.
- **Steps.** The process step registry (`createServerStepRegistry`) holds the internal `data.*` steps and
  what plugins contribute under the key `workflow-steps`.

### Contributing steps

A plugin lists a file under `plugin.taskTypeContributions['workflow-steps']` in its `kibana.jsonc`. It
exports `contribution: WorkflowStepsContribution` whose `register(registry, context)` calls the same
registration function the plugin's `setup()` calls, with services built from `context.host` and
`context.services`. `declares` adds the saved object types, encrypted types, ui settings, settings, feature
flags and event log providers it needs to the module. Rules to follow:

- A plugin sends its settings with `workflowsExtensions.registerTaskProcessSettings(id, getter)` in `setup`.
  They are optional: a disabled plugin sends none and the contribution registers nothing.
- Do not register a step that reads a registry other plugins fill in their own `setup()` (cases attachment
  types, the features registry) unless the registry is filled by contributions too, as agent builder's is
  (see below). It would behave differently from Kibana. A workflow that uses a step the process lacks is
  declined before anything is written, and the task fails.
- `context.registerRunCheck(check)` verifies required registrations and capabilities before a run writes.
  Templated values resolve through the handler at execution time, as in Kibana. A missing capability fails
  the task without changing executors.
- A service that queues events registers a drain with `services.registerRunCompletion`. These drains
  finish before execution-service cleanup and before telemetry and event-log flushing. Drains added by
  other drains are awaited too; a drain failure is reported after all pending work settles.
- A step that reports analytics events lists their types in `declares.analyticsEventTypes`; a step that
  counts usage reads `host.usageCounters.getUsageCounter(domain)`.

Contributions can provide lazy execution services with `provides: { serviceId: (context) => service }`.
`context.services.getService<T>(serviceId)` returns the same instance throughout one run. Agent Builder
contributions use the same resolver. Providers and their mutable registries are rebuilt for the next run,
including when Core and the bundle are reused.

The `workflows.management` and `workflows.extensions` providers share one `WorkflowsRuntime`: the full
management API, request-scoped trigger clients and owner-bound managed workflow clients use the same
services and license checks as Kibana. The `spaces` provider uses the real spaces client and security
wrapper over stored space documents, with the captured feature registry, solution visibility and CPS
routing. `nightshiftSources` uses the source catalog's shared client factory; its change emitter awaits
subscribers before writes return.

`alertingVTwo` uses the plugin's dependency-injection modules for its request-scoped clients. Resource
initializers check deployed data streams, templates and pipelines; Kibana owns installing and upgrading
them. Its event bus drains queued handlers, including nested events, before the run completes. Event
subscribers and the response-format subscription are released for each execution.

Evals exposes its executable registry as `evals.taskProviders`. A plugin that calls `registerTaskProvider`
in Kibana also registers the same provider from its workflow contribution through that service. The
`evalsTaskProviders` dispatch snapshot lists the expected provider names, which are checked against the
completed execution registry. Both literal and templated `task_ref` values execute through that registry.

### Agent builder in a process

`ai.agent`, `ai.conversation.*` and `ai.attachment.*` read agent builder's registries (tools, agents, agent
types, skills, attachment types, conversation templates and event types, renderers, hooks, plugins, the AI
index resolver), which about two dozen plugins fill in their `setup()`. A process has no plugin lifecycle,
so it is built the way the plugin builds it, from explicit dependencies, and filled by contributions.

**The run services.** `createAgentBuilderRunServices(deps)` (`agent_builder/server/run_services`) builds the
`ServiceManager`, registers what agent builder itself registers (the connector tools, the SML tools, the hooks,
the Deductive agent) and returns the registries (`serviceSetups`), the registration surface plugins use in
`setup()` (`setupContract`, an `AgentBuilderPluginSetup`) and a recorder of the ids registered with each
registry. The plugin's `setup()` calls it with Kibana's services; the process
(`task_types/create_agent_builder_process_services.ts`) calls it with the host: the inference services of
`createInferenceTaskProcessServices` (chat models and clients are built from the connectors, with the run's
request and credential), the search inference endpoints with Kibana's complete feature snapshot and the recommended
endpoints Kibana's poller had found (sent as a setting), Core's Elasticsearch, saved objects and ui settings,
the actions client of the run, the usage counter and analytics of the host, the deployment information Kibana
sent, and a space taken from the run's request. The start contract plugins read (`getAgentBuilderStart()`) is
built by `createAgentBuilderStartContract`, which the plugin's `start()` calls too. Asynchronous execution
callbacks use the shared actions configuration and relay client. Conversation events are forwarded to the
workflows triggers with the engine's runtime and flushed before the run answers.

**Contributions.** A plugin lists a file under `plugin.taskTypeContributions['agent-builder']` in its
`kibana.jsonc` that exports `contribution: AgentBuilderContribution` (`@kbn/agent-builder-server`):

```ts
export const contribution: AgentBuilderContribution = {
  // What the registrations read besides Core: merged into what the workflow task types declare.
  declares: {
    settings: [MY_SETTINGS_ID],
    savedObjectTypes: [],
    uiSettings: [],
    featureFlags: {},
    analyticsEventTypes: [],
  },
  register: (agentBuilder, { host, logger, settings, services }) => {
    if (!settings[MY_SETTINGS_ID]) return; // the plugin is not enabled in this Kibana
    registerMyPluginAgentBuilder(agentBuilder, {
      /* services built from `host` and `services` */
    });
  },
};
```

`agentBuilder` is the same `AgentBuilderPluginSetup` plugins register with in `setup()`, and `register` calls the
function `setup()` calls (`registerXAgentBuilder(setup, services)`), so there is one implementation. Rules:

- Everything conditional (config, the serverless project type, a feature flag, whether another plugin is there)
  is decided in Kibana and sent: `agentBuilder.taskProcess?.registerSettings(id, () => value)` in `setup()`, read as
  `settings[id]` and listed in `declares.settings`. Send `() => ({})` at least, so that a plugin that is not
  enabled in this Kibana (a plugin of another solution, `enabled: false`) registers nothing in the process.
- `services` has what a registration reads in Kibana from `coreSetup.getStartServices()` (`getCoreStart`,
  `getActionsStart`, `getInferenceStart`, `getAgentBuilderStart`, `getWorkflowsManagement`), lazily. A registration that
  needs a service the process does not have is not made, and the parity guard reports it: do not register a tool that
  would answer "not available" instead. Services that other plugins own are built from explicit dependencies by a
  function the plugin and the process share (`createLlmTasksStartContract` with `createProductDocReadServices`, and
  `createFilesRunServices`, which the platform contribution uses for the product documentation tool and the image
  attachment type).
- SML types (`agentBuilderSml.registerType`) are registered with `context.registerSmlType`, which takes the place of
  the SML plugin's setup contract (`{ registerType: context.registerSmlType }`). The process owns an SML service
  (`createSmlService`, started with the privileges of the security task plugin) and an SML start contract
  (`createSmlStartContract`), which the SML tools read. Kibana's ids come from `getRegisteredTypeIds()` of the SML plugin,
  and are compared under the `agentBuilder.smlTypes` parity kind.
- Import leaf files, and take the registration function's services as arguments, as for every plugin factory.

**Parity.** Kibana sends the ids it registered with each registry (`workflowsExtensions.registerTaskProcessParity`,
one kind per registry: `agentBuilder.tools`, `.agents`, `.skills`, `.attachmentTypes` ...), read at every dispatch,
and the process compares them with what it registered, in both directions: an id Kibana has that the process lacks
(a plugin that does not contribute yet, a registration the process cannot make) and an id only the process has (a
plugin that contributes but is disabled in this Kibana). The steps that read the registries are declined, with a
warning that names the ids, and the task fails; every other step is served as before. This is not
`TaskTypeModule.parity`, which declines every run of the process: most workflows do not use agents, and they keep
running in a process while contributions are still being added. The parity is `host.parity`, compared with
`findMissingParity`. In Kibana today `ai.agent` is still declined, until the plugins listed below as not yet
contribute.

**The workflows management API.** The hooks that run an agent's workflows, the `workflow` tool type and the tools of
the plugins that run workflows read `workflowsManagement.management`. The process uses the same
`WorkflowsRuntime` and `WorkflowsManagementApi` as Kibana, composed from explicit execution, authorization,
actions, storage, and registry dependencies. The plugin's lifecycle adapter supplies these dependencies
from Core; the `workflows.management` contribution supplies them from the run. CRUD, validation,
inline and saved execution, managed workflows, history, resume, and cancellation share one implementation.
Management side effects include audit events and SML indexing, which the process flushes before replying.
Change history opens the data stream Kibana installed instead of installing assets at worker startup.

`WorkflowStepsContribution.provides` declares lazy run-service providers. `services.getService(id)` resolves
one instance per execution; `registerService` publishes services after asynchronous composition, and
`getExecutionEngine` resolves once all step contributions have registered. Duplicate and circular providers
fail explicitly. Agent Builder publishes its start contract as `agentBuilder`; proposal steps use its
attachment client. KI verifier workflows are scheduled as separate tasks, so their caller can poll and
cancel them through the same access-controlled management API.

**Global ui settings.** `declares.globalUiSettings` (of an `agent-builder` or `workflow-steps` contribution) are
registered with `registerGlobal` in the process (`TaskTypeModule.uiSettings.globalDefaults`) and read with
`host.uiSettings.globalAsScopedToClient`; a key several contributions declare is registered once. The Deductive
agent's settings and the context engine's memory setting are declared this way, so the Deductive agent no longer
declines runs.

**Services a tool reads.** Build them from explicit dependencies in a function the plugin's `setup()`/`start()` and
the contribution share (`createContextEngineRunServices`, `createCasesRunServices`, `createProposalsRunServices`)
and create them lazily: the contribution registers (also with the stub host of `collectRegisteredIds`) before the
services can be built from the host.

A checked-in list of the ids the contributions register (`agent_builder_contribution_ids.json`) and a test that
every plugin that takes `AgentBuilderPluginSetup` either contributes or is listed as not yet (with what it needs)
fail when a plugin registers something new without a contribution. Test a contribution with
`collectRegisteredIds`, and a registration end to end with
`workflow_agent_builder_process.test.ts` (a real bundle, Elasticsearch and a stub LLM behind a `.gen-ai`
connector).

Who contributes: discover, elasticsearch_home, search_getting_started, apm (service map), custom_content,
agent_builder_visualizations and agent_builder_platform (tools, attachment types, skills, templates, event types),
proposals (the services over the plugin's storage, and agent builder's attachments), context_engine_agent_builder
(the AI index services, the signals and improvements stores), cases (the cases client of `createCasesRunServices`,
with the events of the tools bridged to the workflow triggers) and ml (the anomaly detection skill; the
capabilities of a request are resolved from its `ui:ml/*` privileges and the license, there being no Core
capabilities service in a process). Differences from Kibana are in the comment of each contribution (the AI
indices other plugins register as managed, the attachment types and the alerts client of solutions, files, and the
data views of ML recognizers).
Also contributing since: agent_builder_dashboards (the dashboard client of the dashboard plugin, `createDashboardServerClient`;
the embeddable transforms and schemas other plugins register in their `setup()` do not exist in a process, so panels
are read and validated without them), agent_builder_workflows (over the shared management API, including CRUD, validation, inline
execution, and scheduling), and the SML types of visualizations, platform, dashboards and
workflows. Product documentation counts as installed from the status saved objects (an installation in flight is
not looked at; Security Labs is not available).

Also contributing since: streams (the scoped clients of `createStreamsRunServices`: the streams client over its
storage, the scoped Elasticsearch client, the inference client of the process, the license and the fields metadata
service started with the streams extractor; the rules client of alerting that the attachment client uses and the
encrypted saved objects client exist only in Kibana and throw when used, integration fields from Fleet are not
served, and the space solution that gates the tools in Kibana is not known to a process, so the tools are available in
every space of a project type that registers them, which Kibana decides) and evals_skills (the dataset service and the
evaluator registry of the evals plugin, built by the same classes, the model connectors of the process's inference
service and the privileges of the security task plugin; saving and running an experiment use the shared workflow management runtime).

**Registrations after start.** What a plugin registers once Kibana has started (`agentBuilder.skills.register` and
`agents.ensure` of the start contract) can change while Kibana runs (significant events registers its skills when a
feature flag flips on). A contribution adds `registerAtStart(start, context)`, which calls the function the plugin
calls with `start` (`AgentBuilderContributionStart`: `skills.register` and `agents.ensure`). Kibana decides the
current set and sends it as settings with each dispatch (`registerSettings(id, () => current)`, evaluated at every
dispatch), the process runs `registerAtStart` with these settings, so it registers exactly that set and skills
registered at start count in the `agentBuilder.skills` parity. `agents.ensure` in a process only keeps the
availability and visibility of the agent in memory (`setAgentAvailability`): Kibana persisted the agent, a process
does not write it. An availability that holds a callback is sent as data (the result Kibana evaluated for this
dispatch) and rebuilt by the registration as a handler that answers it, or is the process-side equivalent built by the
same factory. Test it with `collectRegisteredIds`, which runs `registerAtStart` too.

Not yet, with what each needs: security_solution,
discoveries, alertzero, agentic_investigations, observability_agent_builder (its 16 tools read the start contracts of
ml, the rule registry, data views and APM, and infra, slo, synthetics and apm register data providers with a nested
registry that has to be fed through the same mechanism), significant_events (its scoped clients over the knowledge
indicator, source catalog, run quota, detections and relay services, and the registrations after start above) and
nightshift_investigations.

### Remaining workflow parity gaps

These remaining capability gaps currently fail process execution; they must be completed for full parity:

- **agent_builder:** `ai.agent`, `ai.conversation.*` (create, metadata read and patch, add event, add user
  message) and `ai.attachment.*` (add, update, delete, read, list) are served only when the process registered
  what Kibana did with agent builder (see above); until the plugins that do not contribute yet do, those runs fail. `ai.rerank` and the triggers run.
- **cases:** `cases.addAlerts`, `cases.addEvents`, `cases.addAttachments`, `cases.deleteAttachments` and
  `cases.deleteCases` (attachment types registered by solutions, the rule registry alerts client, the
  files plugin). Run checks also decline status, close reason and assign steps when Kibana has a listener,
  a close reason validator or an email service the process lacks.
- **alertzero:** `hunt.packageReport`, `alertzero.investigation.summarize`.
- **agentic_investigations:** all four steps.
- **nightshift_investigations:** twelve of the fifteen steps (the investigations client, the sandbox
  plugin and agent execution).

Inference features are sent as the `inferenceFeatures` settings snapshot at each dispatch, including parent
relationships, model policies and the current recommended endpoints. Both AI steps and Agent Builder restore
that registry, so features registered by other plugins and templated `connector-id-by-feature` values resolve
as they do in Kibana. A missing or invalid snapshot fails execution explicitly.

The common cause is the registries. Agent builder's have a contribution mechanism now; the plugins above that
register with it move into processes as they contribute.
