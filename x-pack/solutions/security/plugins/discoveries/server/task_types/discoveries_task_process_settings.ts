/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

/** The id of the plugin's settings in a task process, `host.settings[id]`. */
export const DISCOVERIES_TASK_PROCESS_SETTINGS_ID = 'discoveries';

/** What the steps read of `xpack.discoveries` in a task process. Plain values: they are sent over the wire. */
export interface DiscoveriesTaskProcessSettings {
  connectorTimeout: number;
  langSmithApiKey?: string;
  langSmithProject?: string;
}

/** The settings of the plugin that a task process is sent, from its config. Optional values that are not set are left out. */
export const getDiscoveriesTaskProcessSettings = ({
  connectorTimeout,
  langSmithApiKey,
  langSmithProject,
}: {
  connectorTimeout: number;
  langSmithApiKey?: string;
  langSmithProject?: string;
}): DiscoveriesTaskProcessSettings => ({
  connectorTimeout,
  ...(langSmithApiKey ? { langSmithApiKey } : {}),
  ...(langSmithProject ? { langSmithProject } : {}),
});
