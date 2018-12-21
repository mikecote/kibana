/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

import { get } from 'lodash';
import { resolve } from 'path';
import Boom from 'boom';

import { initServer } from './server';
import mappings from './mappings.json';

export function graph(kibana) {
  return new kibana.Plugin({
    id: 'graph',
    configPrefix: 'xpack.graph',
    publicDir: resolve(__dirname, 'public'),
    require: ['kibana', 'elasticsearch', 'xpack_main'],
    uiExports: {
      app: {
        title: 'Graph',
        order: 9000,
        icon: 'plugins/graph/icon.png',
        euiIconType: 'graphApp',
        description: 'Graph exploration',
        main: 'plugins/graph/app',
      },
      styleSheetPaths: resolve(__dirname, 'public/index.scss'),
      hacks: ['plugins/graph/hacks/toggle_app_link_in_nav'],
      home: ['plugins/graph/register_feature'],
      mappings,
      migrations: {
        'graph-workspace': {
          '7.0.0': (doc) => {
            // Set new "references" attribute
            doc.references = doc.references || [];
            // Migrate index pattern
            const wsState = get(doc, 'attributes.wsState');
            if (typeof wsState === 'string') {
              let state;
              try {
                state = JSON.parse(JSON.parse(wsState));
              } catch (e) {
                const error = new Error('Failed to parse wsState');
                error.doc = doc;
                error.originalError = e;
                throw error;
              }
              const { indexPattern } = state;
              state.indexPatternRef = 'indexPattern_0';
              delete state.indexPattern;
              doc.attributes.wsState = JSON.stringify(JSON.stringify(state));
              doc.references = [
                ...doc.references,
                {
                  name: 'indexPattern_0',
                  type: 'index-pattern',
                  id: indexPattern,
                }
              ];
            } else {
              const error = new Error('Missing wsState');
              error.doc = doc;
              throw error;
            }
            return doc;
          }
        }
      }
    },

    config(Joi) {
      return Joi.object({
        enabled: Joi.boolean().default(true),
        canEditDrillDownUrls: Joi.boolean().default(true),
        savePolicy: Joi.string().valid(['config', 'configAndDataWithConsent', 'configAndData', 'none']).default('configAndData'),
      }).default();
    },

    init(server) {
      server.injectUiAppVars('graph', () => {
        const config = server.config();
        return {
          esApiVersion: config.get('elasticsearch.apiVersion'),
          esShardTimeout: config.get('elasticsearch.shardTimeout'),
          graphSavePolicy: config.get('xpack.graph.savePolicy'),
          canEditDrillDownUrls: config.get('xpack.graph.canEditDrillDownUrls')
        };
      });

      initServer(server);
    },
  });
}
