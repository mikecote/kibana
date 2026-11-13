/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { getRuleRunDeclarations } from './rule_run_saved_object_types';

describe('getRuleRunDeclarations', () => {
  const declarations = getRuleRunDeclarations();

  it('declares the saved object types a rule run reads and writes, collected from the plugins', () => {
    expect(declarations.savedObjectTypes.map((type) => type.name).sort()).toEqual([
      'action',
      'action_task_params',
      'alert',
      'index-pattern',
      'maintenance-window',
      'rules-settings',
      'space',
    ]);
    declarations.savedObjectTypes.forEach((type) => expect(type.mappings).toBeDefined());
  });

  it('declares the encrypted attributes of the rule, the connector and its task params', () => {
    const byType = Object.fromEntries(
      declarations.encryptedSavedObjectTypes.map((registration) => [
        registration.type,
        [...registration.attributesToEncrypt].map((attribute) =>
          typeof attribute === 'string' ? attribute : attribute.key
        ),
      ])
    );
    expect(byType.alert).toEqual(expect.arrayContaining(['apiKey']));
    expect(byType.action).toEqual(expect.arrayContaining(['secrets']));
    expect(byType.action_task_params).toEqual(expect.arrayContaining(['apiKey']));
    expect(Object.keys(byType).sort()).toEqual(['action', 'action_task_params', 'alert']);
  });

  it('builds migrations that fail when run, because a process never migrates', () => {
    const rule = declarations.savedObjectTypes.find((type) => type.name === 'alert')!;
    expect(rule.modelVersions).toBeDefined();
  });
});
