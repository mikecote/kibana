/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { createRegistrationRecorder, REGISTRATION_KINDS } from './registration_recorder';
import type { InternalSetupServices } from '../services';

const createSetups = () =>
  ({
    tools: { register: jest.fn() },
    agents: { register: jest.fn(), registerType: jest.fn(), registerAiIndexResolver: jest.fn() },
    attachments: { registerType: jest.fn() },
    renderers: { register: jest.fn() },
    conversationEvents: { register: jest.fn() },
    conversationTemplates: { register: jest.fn() },
    hooks: { register: jest.fn(), registerCycleHook: jest.fn() },
    skills: { registerSkill: jest.fn() },
    plugins: { register: jest.fn() },
    metering: {},
  } as unknown as InternalSetupServices);

describe('createRegistrationRecorder', () => {
  it('has no ids before anything is registered', () => {
    const { ids } = createRegistrationRecorder();
    expect(Object.keys(ids())).toEqual([...REGISTRATION_KINDS]);
    expect(Object.values(ids()).every((list) => list.length === 0)).toBe(true);
  });

  it('records the id of what is registered, and registers it with the registry as it is', () => {
    const recorder = createRegistrationRecorder();
    const setups = createSetups();
    const recorded = recorder.record(setups);

    const tool = { id: 'z.tool' };
    recorded.tools.register(tool as never);
    recorded.tools.register({ id: 'a.tool' } as never);
    recorded.agents.register({ id: 'agent-1' } as never);
    recorded.agents.registerType({ id: 'type-1' } as never);
    recorded.agents.registerAiIndexResolver((() => []) as never);
    recorded.attachments.registerType({ id: 'attachment-1' } as never);
    recorded.renderers.register({ type: 'renderer-1' } as never);
    recorded.conversationEvents.register({ type: 'event-1' } as never);
    recorded.conversationTemplates.register({ id: 'template-1' } as never);
    recorded.hooks.register({ id: 'hook-1' } as never);
    recorded.hooks.registerCycleHook({ id: 'cycle-1' } as never);
    recorded.skills.registerSkill({ id: 'skill-1' } as never);
    recorded.plugins.register({ id: 'plugin-1' } as never);
    recorder.recordSmlType('sml-1');

    expect(setups.tools.register).toHaveBeenCalledWith(tool);
    expect(recorder.ids()).toEqual({
      tools: ['a.tool', 'z.tool'],
      agents: ['agent-1'],
      agentTypes: ['type-1'],
      skills: ['skill-1'],
      attachmentTypes: ['attachment-1'],
      conversationEvents: ['event-1'],
      conversationTemplates: ['template-1'],
      renderers: ['renderer-1'],
      hooks: ['cycle:cycle-1', 'hook-1'],
      plugins: ['plugin-1'],
      aiIndexResolvers: ['resolver'],
      smlTypes: ['sml-1'],
    });
  });

  it('does not record a registration the registry refused', () => {
    const recorder = createRegistrationRecorder();
    const setups = createSetups();
    (setups.tools.register as jest.Mock).mockImplementation(() => {
      throw new Error('not allowed');
    });
    const recorded = recorder.record(setups);

    expect(() => recorded.tools.register({ id: 'not.allowed' } as never)).toThrow('not allowed');
    expect(recorder.ids().tools).toEqual([]);
  });
});
