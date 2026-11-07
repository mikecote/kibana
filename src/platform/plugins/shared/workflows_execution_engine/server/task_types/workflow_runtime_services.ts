/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type {
  WorkflowStepsContribution,
  WorkflowStepsContributionContext,
} from '@kbn/workflows-extensions/server';

export class WorkflowRuntimeServices {
  private readonly providers = new Map<
    string,
    (context: WorkflowStepsContributionContext) => object
  >();
  private readonly instances = new Map<string, object>();
  private readonly creating = new Set<string>();
  private readonly completions: Array<() => Promise<void>> = [];

  constructor(
    contributions: readonly WorkflowStepsContribution[],
    private readonly getContext: () => WorkflowStepsContributionContext,
    initial: Readonly<Record<string, object>> = {}
  ) {
    for (const [id, instance] of Object.entries(initial)) this.registerService(id, instance);
    for (const contribution of contributions) {
      for (const [id, provider] of Object.entries(contribution.provides ?? {})) {
        if (this.providers.has(id) || this.instances.has(id)) {
          throw new Error(`Duplicate workflow runtime service provider: ${id}`);
        }
        this.providers.set(id, provider);
      }
    }
  }

  public readonly registerService = (id: string, instance: object): void => {
    if (this.providers.has(id) || this.instances.has(id)) {
      throw new Error(`Duplicate workflow runtime service: ${id}`);
    }
    this.instances.set(id, instance);
  };

  public readonly registerRunCompletion = (complete: () => Promise<void>): void => {
    this.completions.push(complete);
  };

  public async complete(): Promise<void> {
    const errors: Error[] = [];
    while (this.completions.length > 0) {
      const results = await Promise.allSettled(
        this.completions.splice(0).map((complete) => Promise.resolve().then(complete))
      );
      for (const result of results) {
        if (result.status === 'rejected') {
          errors.push(
            result.reason instanceof Error ? result.reason : new Error(String(result.reason))
          );
        }
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'Workflow service completion failed');
  }

  public readonly getService = <T extends object>(id: string): T => {
    const existing = this.instances.get(id);
    if (existing) return existing as T;
    const provider = this.providers.get(id);
    if (!provider) throw new Error(`No workflow runtime service provider registered for ${id}`);
    if (this.creating.has(id))
      throw new Error(`Circular workflow runtime service dependency: ${id}`);
    this.creating.add(id);
    try {
      const instance = provider(this.getContext());
      this.instances.set(id, instance);
      return instance as T;
    } finally {
      this.creating.delete(id);
    }
  };
}
