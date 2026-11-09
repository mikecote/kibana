/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { AgentBuilderContributionServices } from '@kbn/agent-builder-server';
import type { LicensingPluginStart } from '@kbn/licensing-plugin/server';

type CoreServices = Awaited<ReturnType<AgentBuilderContributionServices['getCoreStart']>>;

export type AgentBuilderElasticsearch = CoreServices['elasticsearch'];
export type AgentBuilderHttp = CoreServices['http'];
export type AgentBuilderLicensing = Pick<LicensingPluginStart, 'getLicense'>;
