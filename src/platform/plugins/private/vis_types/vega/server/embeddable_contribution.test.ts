/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { of } from 'rxjs';
import { join } from 'node:path';
import { REPO_ROOT } from '@kbn/repo-info';
import { coreMock } from '@kbn/core/server/mocks';
import { createEmbeddableServices } from '@kbn/embeddable-plugin/server/create_embeddable_services';
import type { EmbeddableContribution } from '@kbn/embeddable-plugin/server/task_process/embeddable_contribution';
import { VEGA_EMBEDDABLE_TYPE } from '../common/constants';
import { contribution, registerVegaEmbeddable } from './embeddable_contribution';

it.each([false, true])('preserves the Main Vega schema gate when enabled is %s', (enabled) => {
  const { contribution: urlDrilldown } = jest.requireActual<{
    contribution: EmbeddableContribution;
  }>(
    join(
      REPO_ROOT,
      'x-pack/platform/plugins/private/drilldowns/url_drilldown/server/embeddable_contribution'
    )
  );
  const main = createEmbeddableServices();
  urlDrilldown.register(main.setup, {});
  registerVegaEmbeddable(main.setup, () => enabled);
  const native = createEmbeddableServices();
  urlDrilldown.register(native.setup, {});
  const { featureFlags } = coreMock.createStart();
  featureFlags.getBooleanValue$.mockReturnValue(of(enabled));
  contribution.register(native.setup, { featureFlags });
  expect(native.getRegistrationIds()).toEqual(main.getRegistrationIds());
  expect(Boolean(native.start.getTransforms(VEGA_EMBEDDABLE_TYPE)?.schema)).toBe(enabled);
  expect(Boolean(main.start.getTransforms(VEGA_EMBEDDABLE_TYPE)?.schema)).toBe(enabled);
});
