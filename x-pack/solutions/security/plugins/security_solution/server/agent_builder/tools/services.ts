/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { SecurityEntityEnrichmentServices } from './entity_analytics/entity_services';
import type { SecurityWatchlistToolServices } from './entity_analytics/watchlists/services';
import type { SecurityLeadToolServices } from './entity_analytics/leads/services';
import type { SecurityReadinessToolServices } from './siem_readiness/services';
import type { SecurityRuleCreationServices } from './rule_creation_services';

/** The execution ports consumed by Security's complete shared tool registrar. */
export type SecurityToolServices = SecurityEntityEnrichmentServices &
  SecurityWatchlistToolServices &
  SecurityLeadToolServices &
  SecurityReadinessToolServices &
  SecurityRuleCreationServices;
