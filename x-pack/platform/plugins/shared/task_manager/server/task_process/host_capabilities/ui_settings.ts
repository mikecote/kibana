/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Logger } from '@kbn/logging';
import { UiSettingsClient, getCoreSettings } from '@kbn/core-ui-settings-server-internal';
import type { UiSettingsParams } from '@kbn/core-ui-settings-common';
import { stripVersionQualifier } from '@kbn/std';
import type { TaskHost, TaskTypeModule } from '../../task_type_module';

/**
 * Core's `uiSettings.asScopedToClient` in a task process: the same `UiSettingsClient` Core builds,
 * over the `config` saved object, with Core's settings and the module's as defaults. Like Kibana, a
 * read creates or upgrades the `config` document when it is missing.
 */
export const createStandaloneUiSettings = ({
  kibanaVersion,
  buildNum,
  overrides,
  logger,
  module,
}: {
  kibanaVersion: string;
  buildNum: number;
  overrides?: Record<string, unknown>;
  logger: Logger;
  module: Pick<TaskTypeModule, 'uiSettings'>;
}): NonNullable<TaskHost['uiSettings']> => {
  const defaults: Record<string, UiSettingsParams> = Object.assign(
    {},
    getCoreSettings({ isDist: true, isThemeSwitcherEnabled: false }),
    ...(module.uiSettings?.defaults ?? [])
  );
  return {
    asScopedToClient: (savedObjectsClient) =>
      new UiSettingsClient({
        type: 'config',
        id: stripVersionQualifier(kibanaVersion),
        buildNum,
        savedObjectsClient,
        defaults,
        overrides,
        log: logger,
        namespace: savedObjectsClient.getCurrentNamespace() || 'default',
      }) as never,
  };
};
