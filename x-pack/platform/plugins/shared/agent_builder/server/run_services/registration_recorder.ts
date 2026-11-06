/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { InternalSetupServices } from '../services';

/**
 * The registries plugins fill in their `setup()`, by the name the parity of a task process compares
 * them by (`agentBuilder.<kind>`): Kibana sends the ids it registered and the process compares.
 */
export const REGISTRATION_KINDS = [
  'tools',
  'agents',
  'agentTypes',
  'skills',
  'attachmentTypes',
  'conversationEvents',
  'conversationTemplates',
  'renderers',
  'hooks',
  'plugins',
  'aiIndexResolvers',
] as const;

export type RegistrationKind = (typeof REGISTRATION_KINDS)[number];

export const getParityKind = (kind: RegistrationKind): string => `agentBuilder.${kind}`;

export interface RegistrationRecorder {
  /** The ids registered of each kind, sorted. */
  ids(): Record<RegistrationKind, string[]>;
  /** The same registries, recording what is registered with them. */
  record(setups: InternalSetupServices): InternalSetupServices;
}

const idOf = (definition: unknown, field: 'id' | 'type' = 'id'): string => {
  const value = (definition as Record<string, unknown> | undefined)?.[field];
  return typeof value === 'string' ? value : String(value);
};

/**
 * Records the ids of what is registered with the registries of agent builder, so that Kibana can say
 * what it registered and a task process can compare it with what it did. The registration itself is
 * the registry's own: nothing is changed or copied.
 */
export const createRegistrationRecorder = (): RegistrationRecorder => {
  const registered = Object.fromEntries(
    REGISTRATION_KINDS.map((kind) => [kind, new Set<string>()])
  ) as Record<RegistrationKind, Set<string>>;

  return {
    ids: () =>
      Object.fromEntries(
        REGISTRATION_KINDS.map((kind) => [kind, [...registered[kind]].sort()])
      ) as Record<RegistrationKind, string[]>,

    record: (setups) => {
      const track =
        <A extends unknown[], R>(
          kind: RegistrationKind,
          register: (...args: A) => R,
          getId: (...args: A) => string
        ) =>
        (...args: A): R => {
          const result = register(...args);
          registered[kind].add(getId(...args));
          return result;
        };

      return {
        ...setups,
        tools: {
          ...setups.tools,
          register: track('tools', setups.tools.register.bind(setups.tools), (tool) => idOf(tool)),
        },
        agents: {
          ...setups.agents,
          register: track('agents', setups.agents.register.bind(setups.agents), (agent) =>
            idOf(agent)
          ),
          registerType: track(
            'agentTypes',
            setups.agents.registerType.bind(setups.agents),
            (type) => idOf(type)
          ),
          registerAiIndexResolver: track(
            'aiIndexResolvers',
            setups.agents.registerAiIndexResolver.bind(setups.agents),
            (_resolver): string => 'resolver'
          ),
        },
        attachments: {
          ...setups.attachments,
          registerType: track(
            'attachmentTypes',
            setups.attachments.registerType.bind(setups.attachments),
            (type) => idOf(type)
          ),
        },
        renderers: {
          ...setups.renderers,
          register: track('renderers', setups.renderers.register.bind(setups.renderers), (type) =>
            idOf(type, 'type')
          ),
        },
        conversationEvents: {
          ...setups.conversationEvents,
          register: track(
            'conversationEvents',
            setups.conversationEvents.register.bind(setups.conversationEvents),
            (definition) => idOf(definition, 'type')
          ),
        },
        conversationTemplates: {
          ...setups.conversationTemplates,
          register: track(
            'conversationTemplates',
            setups.conversationTemplates.register.bind(setups.conversationTemplates),
            (template) => idOf(template)
          ),
        },
        hooks: {
          ...setups.hooks,
          register: track('hooks', setups.hooks.register.bind(setups.hooks), (bundle) =>
            idOf(bundle)
          ),
          registerCycleHook: track(
            'hooks',
            setups.hooks.registerCycleHook.bind(setups.hooks),
            (definition) => `cycle:${idOf(definition)}`
          ),
        },
        skills: {
          ...setups.skills,
          registerSkill: track('skills', setups.skills.registerSkill.bind(setups.skills), (skill) =>
            idOf(skill)
          ),
        },
        plugins: {
          ...setups.plugins,
          register: track('plugins', setups.plugins.register.bind(setups.plugins), (plugin) =>
            idOf(plugin)
          ),
        },
      };
    },
  };
};
