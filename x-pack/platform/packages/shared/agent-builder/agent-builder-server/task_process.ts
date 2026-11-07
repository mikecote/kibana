/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { EventTypeOpts } from '@kbn/core-analytics-server';
import type { CoreStart } from '@kbn/core-lifecycle-server';
import type { KibanaRequest } from '@kbn/core-http-server';
import type { SavedObjectsType } from '@kbn/core-saved-objects-server';
import type { DataStreamsSetup } from '@kbn/core-data-streams-server';
import type { UiSettingsParams } from '@kbn/core-ui-settings-common';
import type { Logger } from '@kbn/logging';
import type { AgentBuilderPluginSetup, AgentBuilderPluginStart } from './plugin_contract';

/**
 * The contribution key under which plugins add what they register with agent builder to the task
 * process of the workflow task types: `plugin.taskTypeContributions['agent-builder']` in `kibana.jsonc`.
 */
export const AGENT_BUILDER_CONTRIBUTIONS_KEY = 'agent-builder';

/**
 * What a registration of the contributing plugin reads besides Core's own, which the process has to
 * be told. Merged by the workflow task types into what a task process registers.
 */
export interface AgentBuilderContributionDeclares {
  /** Saved object types the registrations (tools, attachment types ...) read or write. */
  savedObjectTypes?: SavedObjectsType[];
  /** Data streams initialized lazily by the registrations' execution services. */
  dataStreams?: Array<Parameters<DataStreamsSetup['registerDataStream']>[0]>;
  /** The ids of the plugin configs the registrations read, as `context.settings[id]`. */
  settings?: string[];
  /** Ui settings the registrations read, as `core.uiSettings.register` takes them. */
  uiSettings?: Array<Record<string, UiSettingsParams>>;
  /** Global ui settings the registrations read, as `registerGlobal` takes them (`host.uiSettings.globalAsScopedToClient`). */
  globalUiSettings?: Array<Record<string, UiSettingsParams>>;
  /** Feature flags the registrations read, with their fallbacks. */
  featureFlags?: Record<string, boolean | string | number>;
  /** Analytics event types the registrations report, which Core requires to be registered. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  analyticsEventTypes?: Array<EventTypeOpts<any>>;
}

/**
 * What the process has in place of what a registration reads in Kibana from
 * `coreSetup.getStartServices()`: Core's start services, the start contracts of the plugins it reads
 * and agent builder's own. All of them are read lazily, when a tool, hook or attachment type runs, and
 * not while registering. Execution dependencies use their shared runtime implementations.
 */
export interface AgentBuilderContributionServices {
  /** Resolves a contributed service for this execution. */
  getService: <T extends object>(id: string) => T;
  /** What a tool reads of Core: the Elasticsearch client, saved objects, ui settings and the base path. */
  getCoreStart: () => Promise<
    Pick<CoreStart, 'elasticsearch' | 'savedObjects' | 'uiSettings' | 'http'>
  >;
  /** The actions plugin as far as a run uses it (the actions client of a request); cast it to `ActionsPluginStart`. */
  getActionsStart: () => Promise<unknown>;
  /** The inference plugin's start contract as a process has it (cast it to `InferenceServerStart`): chat models and clients built from the run's connectors. */
  getInferenceStart: () => unknown;
  /** The actions client of a request: the one of the connectors the process runs. */
  getActionsClientWithRequest: (request: KibanaRequest) => Promise<unknown>;
  /**
   * The workflows management API as a process serves it (`workflowsManagement.management` in Kibana),
   * cast it to `WorkflowsServerPluginSetup['management']`. This is the full shared management API,
   * including authoring, validation, inline execution, resume, and cancellation.
   */
  getWorkflowsManagement: () => unknown;
  /**
   * Emits a workflow trigger event, as `workflowsExtensions.getClient(request).emitEvent` does in
   * Kibana: the workflows it matches are scheduled by this run's process. A tool that makes changes
   * other workflows trigger on (a case created) emits through it, and the run waits for the emissions
   * before it ends.
   */
  emitEvent: (params: {
    triggerId: string;
    payload: Record<string, unknown>;
    request: KibanaRequest;
  }) => Promise<void>;
  /** Agent builder's own start contract, as other plugins read it from their start dependencies. */
  getAgentBuilderStart: () => AgentBuilderPluginStart;
}

/** What a contribution may use: the process (its host), not the plugins around it. */
export interface AgentBuilderContributionContext {
  /** The task host of the process (`TaskHost` of Task Manager); the services a registration is built from. */
  host: unknown;
  logger: Logger;
  isServerless: boolean;
  kibanaVersion: string;
  /**
   * The validated configs Kibana sent, by plugin id: the plugin's own (`taskProcess.registerSettings`
   * in its `setup()`) and the ones the engine always sends. Conditional registrations (config, project
   * type, feature flags, whether another plugin is present) are decided in Kibana and read here, so that
   * the process registers exactly what Kibana did.
   */
  settings: Record<string, unknown>;
  /** The services a registration reads lazily, in place of Kibana's start services. */
  services: AgentBuilderContributionServices;
  /**
   * Registers an SML type (an `SmlTypeDefinition` of `@kbn/agent-builder-sml-plugin`), as
   * `agentBuilderSml.registerType` does in `setup()`: pass `{ registerType: context.registerSmlType }`
   * wherever the registration function takes the SML plugin's setup contract.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerSmlType: (definition: any) => void;
}

/**
 * What a plugin registers with agent builder after start (`agentBuilder.skills.register` and
 * `agentBuilder.agents.ensure` of the start contract), which may change while Kibana runs (a feature
 * flag flips). Kibana decides the current set and sends it as settings with each dispatch; the process
 * runs the contribution's `registerAtStart` with these, so it registers exactly that set.
 */
export interface AgentBuilderContributionStart {
  skills: {
    /** Registers a skill, as `AgentBuilderPluginStart['skills']['register']` does. */
    register: AgentBuilderPluginStart['skills']['register'];
  };
  agents: {
    /**
     * As `AgentBuilderPluginStart['agents']['ensure']`, but for the part that lives in a process:
     * the availability and visibility of the agent. The agent itself is persisted by Kibana, a
     * process does not write it. An `availability` that holds a callback is built by the registration
     * from what Kibana sent (the result of the check, evaluated per dispatch).
     */
    ensure: AgentBuilderPluginStart['agents']['ensure'];
  };
}

/**
 * What a plugin adds to agent builder's registries in the task process of the workflow task types, as
 * it adds it to Kibana in its `setup()`. Exported as `contribution` from a file listed under
 * `plugin.taskTypeContributions['agent-builder']` in the plugin's `kibana.jsonc`.
 *
 * `register` calls the same function `setup()` calls (`registerXAgentBuilder(setup, services)`) with
 * the registration surface agent builder gives a plugin in `setup()`. A registration that needs a
 * service a process does not have is not made: the process then lacks the id Kibana registered, and
 * the runs that read the registries are declined (see the parity guard of agent builder).
 */
export interface AgentBuilderContribution {
  declares?: AgentBuilderContributionDeclares;
  register(
    setup: AgentBuilderPluginSetup,
    context: AgentBuilderContributionContext
  ): void | Promise<void>;
  /**
   * The registrations Kibana makes after start (skills registered through the start contract,
   * persisted agents with their availability), as the plugin makes them: call the function the plugin
   * calls with this `start`. What varies while Kibana runs is sent as settings per dispatch
   * (`registerSettings(id, () => current)`), and read here as `context.settings[id]`.
   */
  registerAtStart?(
    start: AgentBuilderContributionStart,
    context: AgentBuilderContributionContext
  ): void | Promise<void>;
}
