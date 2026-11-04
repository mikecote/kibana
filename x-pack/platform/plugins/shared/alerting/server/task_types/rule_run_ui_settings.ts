/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { UiSettingsParams } from '@kbn/core-ui-settings-common';
import { getUiSettings as getDataUiSettings } from '@kbn/data-plugin/server/ui_settings';
import { getUiSettings as getFieldFormatsUiSettings } from '@kbn/field-formats-plugin/server/ui_settings';

/** A value for any property of a doc links object, for settings whose descriptions link to docs. */
const anyDocLink = (): unknown =>
  new Proxy(() => '', {
    get: (_target, property) => (property === Symbol.toPrimitive ? () => '' : anyDocLink()),
  });

/**
 * The ui settings a rule run reads besides Core's, which the plugins that own them register in
 * Kibana: the search ones of the data plugin and the field formats ones.
 */
export const getRuleRunUiSettings = (): Array<Record<string, UiSettingsParams>> => [
  getDataUiSettings({ links: anyDocLink() } as never, false) as Record<string, UiSettingsParams>,
  getFieldFormatsUiSettings() as Record<string, UiSettingsParams>,
];
