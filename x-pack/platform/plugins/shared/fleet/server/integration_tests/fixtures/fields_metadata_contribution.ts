/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { createHash } from 'node:crypto';

import type { FieldsMetadataServerStart } from '@kbn/fields-metadata-plugin/server';
import { StepCategory } from '@kbn/workflows';
import { createServerStepDefinition } from '@kbn/workflows-extensions/server';
import type { WorkflowStepsContribution } from '@kbn/workflows-extensions/server';
import { z } from '@kbn/zod/v4';

import type { FleetWorkflowRunServices } from '../../services/run_time/workflow_run_services';
import { getBundledPackages } from '../../services/epm/packages/bundled_packages';
import {
  getGpgKeyOrUndefined,
  verifyPackageArchiveSignature,
} from '../../services/epm/packages/package_verification';

export const contribution: WorkflowStepsContribution = {
  register: (registry, { services, logger }) => {
    if (!services) throw new Error('The metadata fixture requires workflow services');
    const metadata = services.getService<FieldsMetadataServerStart>('fieldsMetadata');
    registry.registerStepDefinition(
      createServerStepDefinition({
        id: 'test.fleet.metadata',
        label: 'Read integration metadata',
        description: 'Read native package fields and portable package material',
        category: StepCategory.Kibana,
        inputSchema: z.object({}),
        outputSchema: z.object({
          source: z.string().nullable(),
          description: z.string().nullable(),
          archiveSha256: z.string(),
          keyId: z.string(),
          verificationStatus: z.string().nullable(),
        }),
        handler: async (context) => {
          const client = await metadata.getClient(context.contextManager.getFakeRequest());
          const field = await client.getByName('fixture.logs.marker', {
            source: 'integration',
            integration: 'fixture',
            dataset: 'fixture.logs',
          });
          // Raw archive checks also run when authorization skips the metadata extractor.
          await services.getService<FleetWorkflowRunServices>('fleet.runServices').getServices();
          const [archive] = await getBundledPackages();
          const key = await getGpgKeyOrUndefined();
          if (!archive || !key) throw new Error('The native package material was not restored');
          const verification = field
            ? await verifyPackageArchiveSignature({
                pkgName: archive.name,
                pkgVersion: archive.version,
                pkgArchiveBuffer: await archive.getBuffer(),
                logger,
              })
            : undefined;
          return {
            output: {
              source: field?.toPlain().source ?? null,
              description: field?.toPlain().description ?? null,
              archiveSha256: createHash('sha256')
                .update(await archive.getBuffer())
                .digest('hex'),
              keyId: key.getKeyID().toHex(),
              verificationStatus: verification?.verificationStatus ?? null,
            },
          };
        },
      })
    );
  },
};
