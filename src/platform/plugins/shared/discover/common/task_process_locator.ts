/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { LocatorDefinition } from '@kbn/share-plugin/common';
import { setStateToKbnUrl } from '@kbn/kibana-utils-plugin/common';
import { DISCOVER_APP_LOCATOR } from './app_locator';
import type { DiscoverAppLocatorParams } from './app_locator';
import { appLocatorGetLocationCommon } from './app_locator_get_location';
import { createProfileStateRegistry } from './context_awareness/create_profile_state_registry';

/**
 * The Discover locator for a process that builds links without the Discover plugin, such as the task
 * process of a rule type: the same definition the plugin registers on the server.
 */
export const createDiscoverAppLocatorDefinition =
  (): LocatorDefinition<DiscoverAppLocatorParams> => {
    const profileStateRegistry = createProfileStateRegistry();
    return {
      id: DISCOVER_APP_LOCATOR,
      getLocation: (params) =>
        appLocatorGetLocationCommon(
          { useHash: false, setStateToKbnUrl, profileStateRegistry },
          params
        ),
    };
  };
