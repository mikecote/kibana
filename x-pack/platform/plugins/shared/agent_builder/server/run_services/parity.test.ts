/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { describeAgentBuilderParityGap, registerAgentBuilderParity } from './parity';
import { REGISTRATION_KINDS } from './registration_recorder';
import type { RegistrationKind } from './registration_recorder';

const idsOf = (ids: Partial<Record<RegistrationKind, string[]>>) =>
  Object.fromEntries(REGISTRATION_KINDS.map((kind) => [kind, ids[kind] ?? []])) as Record<
    RegistrationKind,
    string[]
  >;
const expectedOf = (ids: Partial<Record<RegistrationKind, string[]>>) =>
  REGISTRATION_KINDS.map((kind) => ({ kind: `agentBuilder.${kind}`, ids: ids[kind] ?? [] }));

describe('describeAgentBuilderParityGap', () => {
  it('has no gap when Kibana sent nothing to compare (a remote process)', () => {
    expect(describeAgentBuilderParityGap(undefined, idsOf({ tools: ['a'] }))).toBeUndefined();
  });

  it('has no gap when the process registered what Kibana did', () => {
    const ids = { tools: ['a', 'b'], skills: ['s'] };
    expect(describeAgentBuilderParityGap(expectedOf(ids), idsOf(ids))).toBeUndefined();
  });

  it('names what Kibana has and the process lacks', () => {
    expect(
      describeAgentBuilderParityGap(
        expectedOf({ tools: ['a', 'b'], attachmentTypes: ['x'] }),
        idsOf({ tools: ['a'] })
      )
    ).toBe('lacks tools [b]; attachmentTypes [x]');
  });

  it('names what the process has and Kibana does not (a plugin disabled in this Kibana)', () => {
    expect(
      describeAgentBuilderParityGap(expectedOf({ tools: ['a'] }), idsOf({ tools: ['a', 'extra'] }))
    ).toBe('has registered, and Kibana has not, tools [extra]');
  });

  it('names both', () => {
    expect(
      describeAgentBuilderParityGap(
        expectedOf({ skills: ['kibana'] }),
        idsOf({ skills: ['process'] })
      )
    ).toBe('lacks skills [kibana]; has registered, and Kibana has not, skills [process]');
  });

  it('ignores the parity of other kinds', () => {
    expect(
      describeAgentBuilderParityGap(
        [...expectedOf({}), { kind: 'connectorTypes', ids: ['.email'] }],
        idsOf({})
      )
    ).toBeUndefined();
  });
});

describe('registerAgentBuilderParity', () => {
  it('registers what Kibana has of every kind, read when a run is dispatched', () => {
    const registered: Record<string, () => string[]> = {};
    const ids = idsOf({ tools: ['a'] });
    registerAgentBuilderParity(
      { registerTaskProcessParity: (kind, getIds) => (registered[kind] = getIds) },
      () => ids
    );

    expect(Object.keys(registered)).toEqual(
      REGISTRATION_KINDS.map((kind) => `agentBuilder.${kind}`)
    );
    expect(registered['agentBuilder.tools']()).toEqual(['a']);
    ids.tools = ['a', 'b'];
    expect(registered['agentBuilder.tools']()).toEqual(['a', 'b']);
  });
});
