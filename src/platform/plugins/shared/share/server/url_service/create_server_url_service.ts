/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { UrlService } from '../../common/url_service';
import { ServerShortUrlClientFactory } from './short_urls/short_url_client_factory';
import { LegacyShortUrlLocatorDefinition } from '../../common/url_service/locators/legacy_short_url_locator';
import { ShortUrlRedirectLocatorDefinition } from '../../common/url_service/locators/short_url_redirect_locator';
import type { ServerUrlService } from './types';

/** Creates the native server locator and short URL services used by Main and task processes. */
export const createServerUrlService = ({
  baseUrl,
  version,
  onBackgroundTask,
}: {
  baseUrl: string;
  version: string;
  onBackgroundTask?: (task: Promise<void>) => void;
}): ServerUrlService => {
  const service = new UrlService({
    baseUrl,
    version,
    navigate: async () => {
      throw new Error('Locator .navigate() is not supported on the server.');
    },
    getUrl: async () => {
      throw new Error('Locator .getUrl() currently is not supported on the server.');
    },
    shortUrls: ({ locators }) =>
      new ServerShortUrlClientFactory({ currentVersion: version, locators, onBackgroundTask }),
  });
  service.locators.create(new LegacyShortUrlLocatorDefinition());
  service.locators.create(new ShortUrlRedirectLocatorDefinition());
  return service;
};
