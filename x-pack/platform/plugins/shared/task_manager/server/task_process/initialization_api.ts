/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { remotable } from '@kbn/core-remote-common';
import type { PreparedInit } from './init_inventory';
import { digestValue } from './init_inventory';
import type { TaskProcessParity } from './parity';

type ComparisonDirection = 'missing-main-only' | 'bidirectional';
// Worker-only workflow steps are legitimate; Agent Builder deliberately requires identical sets.
const parityDirections: Readonly<Record<string, ComparisonDirection>> = {
  'agentBuilder.tools': 'bidirectional',
  'agentBuilder.agents': 'bidirectional',
  'agentBuilder.agentTypes': 'bidirectional',
  'agentBuilder.skills': 'bidirectional',
  'agentBuilder.attachmentTypes': 'bidirectional',
  'agentBuilder.conversationEvents': 'bidirectional',
  'agentBuilder.conversationTemplates': 'bidirectional',
  'agentBuilder.renderers': 'bidirectional',
  'agentBuilder.hooks': 'bidirectional',
  'agentBuilder.plugins': 'bidirectional',
  'agentBuilder.aiIndexResolvers': 'bidirectional',
  'agentBuilder.smlTypes': 'bidirectional',
};

export interface InitializationSource {
  read: () => Promise<PreparedInit>;
  getParity: () => TaskProcessParity;
}

/** Main-owned boot inventories, static content and lazy native registration witnesses. */
export class InitializationApi {
  private prepared?: Promise<PreparedInit>;
  private readonly witnesses = new Map<string, { digest: string; ids: Record<string, string[]> }>();
  constructor(private readonly source: InitializationSource) {}

  async inventories(): Promise<PreparedInit['inventories']> {
    return (await (this.prepared ??= this.source.read())).inventories;
  }

  async content(digest: string): Promise<string> {
    const files = (await (this.prepared ??= this.source.read())).content;
    if (!Object.hasOwn(files, digest)) throw new Error('Unknown installed asset digest');
    return files[digest];
  }

  registrations(group: string, digest: string, ids?: Record<string, string[]>): string | null {
    const existing = this.witnesses.get(group);
    if (ids) {
      if (digestValue(ids) !== digest || Object.keys(ids).sort().join(',') !== group) {
        throw new Error('Invalid native registration witness');
      }
      this.witnesses.set(group, { digest, ids });
    } else if (existing?.digest !== digest) {
      throw new Error('Unknown native registration digest');
    }
    const witness = this.witnesses.get(group);
    if (!witness) throw new Error('Missing native registration witness');
    return this.compare(witness.ids);
  }

  assertCurrent(): void {
    for (const { ids } of this.witnesses.values()) {
      const gap = this.compare(ids);
      if (gap) throw new Error(gap);
    }
  }

  private compare(actual: Record<string, string[]>): string | null {
    const gaps: string[] = [];
    const comparisons = this.source.getParity().map(({ kind, ids }) => ({
      kind,
      ids,
      direction: parityDirections[kind] ?? 'missing-main-only',
    }));
    for (const { kind, ids, direction } of comparisons) {
      if (!Object.hasOwn(actual, kind)) continue;
      const have = new Set(actual[kind]);
      const expected = new Set(ids);
      const missing = ids.filter((id) => !have.has(id));
      const extra =
        direction === 'bidirectional' ? actual[kind].filter((id) => !expected.has(id)) : [];
      if (missing.length || extra.length)
        gaps.push(`${kind}: missing [${missing.join(', ')}], extra [${extra.join(', ')}]`);
    }
    return gaps.length ? gaps.join('; ') : null;
  }
}
remotable(InitializationApi);
