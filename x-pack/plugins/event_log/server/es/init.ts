/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

import { getIlmPolicy, getIndexTemplate } from './documents';
import { EsContext } from './context';

export async function initializeEs(esContext: EsContext): Promise<boolean> {
  esContext.logger.debug('initializing elasticsearch resources starting');

  try {
    await initializeEsResources(esContext);
  } catch (err) {
    esContext.logger.error(`error initializing elasticsearch resources: ${err.message}`);
    return false;
  }

  esContext.logger.debug('initializing elasticsearch resources complete');
  return true;
}

async function initializeEsResources(esContext: EsContext) {
  const steps = new EsInitializationSteps(esContext);

  await steps.createIlmPolicyIfNotExists();
  await steps.createIndexTemplateIfNotExists();
  await steps.createInitialIndexIfNotExists();
}

class EsInitializationSteps {
  constructor(private readonly esContext: EsContext) {
    this.esContext = esContext;
  }

  async createIlmPolicyIfNotExists(): Promise<void> {
    const ilmPolicyExists = await this.esContext.esAdapter.doesIlmPolicyExist(
      this.esContext.esNames.ilmPolicy
    );
    if (!ilmPolicyExists) {
      await this.esContext.esAdapter.createIlmPolicy(
        this.esContext.esNames.ilmPolicy,
        getIlmPolicy()
      );
    }
  }

  async createIndexTemplateIfNotExists(): Promise<void> {
    const indexTemplateExists = await this.esContext.esAdapter.doesIndexTemplateExist(
      this.esContext.esNames.indexTemplate
    );
    if (!indexTemplateExists) {
      const templateBody = getIndexTemplate(this.esContext.esNames);
      await this.esContext.esAdapter.createIndexTemplate(
        this.esContext.esNames.indexTemplate,
        templateBody
      );
    }
  }

  async createInitialIndexIfNotExists(): Promise<void> {
    const initialIndexExists = await this.esContext.esAdapter.doesAliasExist(
      this.esContext.esNames.alias
    );
    if (!initialIndexExists) {
      await this.esContext.esAdapter.createIndex(this.esContext.esNames.initialIndex);
    }
  }
}
