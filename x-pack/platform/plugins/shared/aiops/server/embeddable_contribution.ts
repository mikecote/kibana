/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { EmbeddableSetup } from '@kbn/embeddable-plugin/server';
import type { EmbeddableContribution } from '@kbn/embeddable-plugin/server/task_process/embeddable_contribution';
import { EMBEDDABLE_LOG_RATE_ANALYSIS_TYPE } from '@kbn/aiops-log-rate-analysis/constants';
import { EMBEDDABLE_PATTERN_ANALYSIS_TYPE } from '@kbn/aiops-log-pattern-analysis/constants';
import { EMBEDDABLE_CHANGE_POINT_CHART_TYPE } from '@kbn/aiops-change-point-detection/constants';
import { changePointChartEmbeddableStateSchema } from '@kbn/aiops-server-schemas/embeddables/change_point_chart';
import { patternAnalysisEmbeddableStateSchema } from '@kbn/aiops-server-schemas/embeddables/pattern_analysis';
import { logRateAnalysisEmbeddableStateSchema } from '@kbn/aiops-server-schemas/embeddables/log_rate_analysis';
import { transformIn as changePointTransformIn } from '../common/embeddables/change_point_chart/transform_in';
import { transformOut as changePointTransformOut } from '../common/embeddables/change_point_chart/transform_out';
import { transformIn as logRateTransformIn } from '../common/embeddables/log_rate_analysis/transform_in';
import { transformOut as logRateTransformOut } from '../common/embeddables/log_rate_analysis/transform_out';
import { transformIn as patternAnalysisTransformIn } from '../common/embeddables/pattern_analysis/transform_in';
import { transformOut as patternAnalysisTransformOut } from '../common/embeddables/pattern_analysis/transform_out';

/** Registers the plugin's native embeddable definitions in Main and workers. */
export const registerEmbeddableDefinitions = (embeddable: EmbeddableSetup): void => {
  embeddable.registerEmbeddableServerDefinition(EMBEDDABLE_CHANGE_POINT_CHART_TYPE, {
    title: 'Change point detection chart',
    getSchema: () => changePointChartEmbeddableStateSchema,
    getTransforms: () => ({
      transformIn: changePointTransformIn,
      transformOut: changePointTransformOut,
    }),
  });
  embeddable.registerEmbeddableServerDefinition(EMBEDDABLE_PATTERN_ANALYSIS_TYPE, {
    title: 'Pattern analysis',
    getSchema: () => patternAnalysisEmbeddableStateSchema,
    getTransforms: () => ({
      transformIn: patternAnalysisTransformIn,
      transformOut: patternAnalysisTransformOut,
    }),
  });
  embeddable.registerEmbeddableServerDefinition(EMBEDDABLE_LOG_RATE_ANALYSIS_TYPE, {
    title: 'Log rate analysis',
    getSchema: () => logRateAnalysisEmbeddableStateSchema,
    getTransforms: () => ({
      transformIn: logRateTransformIn,
      transformOut: logRateTransformOut,
    }),
  });
};

export const contribution: EmbeddableContribution = { register: registerEmbeddableDefinitions };
