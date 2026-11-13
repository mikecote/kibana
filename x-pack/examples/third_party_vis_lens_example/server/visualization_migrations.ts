/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { DEFAULT_COLOR } from '../common/constants';
import type { RotatingNumberState } from '../common/types';

interface Pre81RotatingNumberState {
  column?: string;
  layerId: string;
}

/** Returns the custom visualization migrations registered in both Main and workers. */
export const getRotatingNumberMigrations = (): {
  '8.1.0': (oldState: Pre81RotatingNumberState) => RotatingNumberState;
} => ({
  '8.1.0': (oldState: Pre81RotatingNumberState): RotatingNumberState => ({
    accessor: oldState.column,
    layerId: oldState.layerId,
    color: DEFAULT_COLOR,
  }),
});
