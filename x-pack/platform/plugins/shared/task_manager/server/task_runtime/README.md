# Task type modules

A task type module is one importable file that holds everything a Task Manager task type needs to
run: its definition, the services it asks for, and its runner. The same file runs three ways:

1. **In Kibana**, registered with `registerTaskType` (Kibana claims, validates and reschedules).
2. **In a child process Kibana starts**, from a bundle (`xpack.task_manager.task_processes`).
3. **In an external pod**, from the same bundle (`xpack.task_manager.pods`, `bin/kibana-task`).

Modes 2 and 3 are dispatched by Kibana's Task Manager through `task_pod/` (`POST /run`); a task type
that has no live process runs in Kibana, so a crashed process never strands a task.

## Writing one

```ts
// <plugin>/server/task_types/my_task.task.ts
export const taskType = defineTaskType({
  type: 'myPlugin:my_task',
  definition: { title: 'My task', timeout: '1m' },     // what Kibana registers, minus the runner
  requiresFakeRequest: false,                           // default true
  modules: [myServiceModule],                           // how a task process provides `needs`
  needs: { es: InternalElasticsearchClient, logger: Logger, runner: MyRunnerClass },
  createRunner: ({ es, logger }, context) => ({ run: async () => ({ state: {} }) }),
});
```

- `needs` lists DI tokens, or classes the container builds (`@injectable`, explicit `@inject`).
  Authors never write a container; plain functions work.
- Declare the file in `kibana.jsonc`: `"plugin": { "taskTypes": ["server/task_types/my_task.task.ts"] }`.
- In Kibana: `registerTaskType(taskManager, taskType, { resolve: async () => ({ ... }) })` (plain
  plugins) or `{ container: () => container }` (DI plugins).
- Import only leaf files. `node scripts/task_bundle --name my_task --why <package>` prints the import
  chain that pulls a package in; the build fails on forbidden inputs (`src/dev/task_bundles/forbidden_inputs.js`).

## Running and measuring

```
node scripts/task_bundle                               # build every declared task type to target/task_bundles
node scripts/task_bundle --name my_task --size         # largest packages in a bundle
node scripts/task_bundle --measure                     # fresh-process time to ready and RSS
node scripts/task_bundle --update-limits | --validate-limits   # src/dev/task_bundles/limits.yml
bin/kibana-task myPlugin:my_task                       # from a distributable
```

Fresh process, Node 24, `--max-semi-space-size=8`, no Elasticsearch needed to start:

| Task type | Bundle | Ready | RSS |
| --- | --- | --- | --- |
| `alerting_v2:alert_actions_cleanup` | 4.8 MB | ~105 ms | ~106 MB |
| `task_manager:delete_inactive_background_task_nodes` (saved objects) | 7.0 MB | ~110 ms | ~116 MB |

For comparison, attempt 1's whole alerting v2 pod measured about 240 MB from the built tree.

## What a task process has

`@kbn/core-task-host-server-internal`: a JSON logger, Core's own Elasticsearch `ClusterClient`, an
inversify container with Core's request-scoped Elasticsearch tokens, and the fake request user
binding. Saved objects (`savedObjectsModule`) are opt-in: only units that list the module load them.
No plugins, no plugin discovery, no HTTP server.

## Not done yet

- `actions:<connector type>` and `alerting_v2:rule_executor` units. The rule executor's bindings come
  from `bindServices`, which binds the whole plugin (10 MB, 5000 files); it needs a carve-out. Connectors
  need the actions execute path split from `createActionsExecuteRuntime`, plus service modules for
  encrypted saved objects, event log, spaces and licensing (the bodies exist on `poc/alerting-v2-task-pods`).
- Definition digest in the wire protocol (Kibana's registered definition has defaults the unit lacks).
- Integration tests that run Kibana against a bundle in all three modes. The supervisor and
  `RemoteTaskRunner` were exercised end to end by hand against Elasticsearch.
- An eslint rule for `task_types/**`; the bundler's forbidden-inputs check covers the closure.
