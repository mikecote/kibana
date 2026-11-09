/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { AgentBuilderPluginStart } from '@kbn/agent-builder-server';
import {
  ToolResultType,
  AgentExecutionMode,
  agentBuilderDefaultAgentId,
} from '@kbn/agent-builder-common';
import { AgentPromptType } from '@kbn/agent-builder-common/agents/prompts';
import { StepCategory } from '@kbn/workflows';
import { createServerStepDefinition } from '@kbn/workflows-extensions/server';
import type { WorkflowStepsContribution } from '@kbn/workflows-extensions/server';
import { z } from '@kbn/zod/v4';
import { SECURITY_RUN_RULE_PREVIEW_TOOL_ID } from '../../../agent_builder/tools/run_rule_preview_tool';
import { SECURITY_ENTITY_RISK_SCORE_TOOL_ID } from '../../../agent_builder/tools/entity_analytics/entity_risk_score_tool';
import { SECURITY_BUILD_REDIRECT_URL_TOOL_ID } from '../../../agent_builder/tools/build_redirect_url_tool';
import { SECURITY_LIST_RESOLUTION_RULES_TOOL_ID } from '../../../agent_builder/tools/entity_analytics/resolution/list_resolution_rules_tool';
import { SECURITY_SET_RESOLUTION_RULES_TOOL_ID } from '../../../agent_builder/tools/entity_analytics/resolution/set_resolution_rules_tool';

export const contribution: WorkflowStepsContribution = {
  register: (registry, { services }) => {
    if (!services) throw new Error('Security core tools require native execution services');
    registry.registerStepDefinition(
      createServerStepDefinition({
        id: 'test.security.core_tools',
        label: 'Native Security core tools',
        description: 'Execute the real Security risk-score and navigation tools',
        category: StepCategory.Kibana,
        inputSchema: z.object({}),
        outputSchema: z.object({
          riskScores: z.array(
            z.object({ id_value: z.string(), calculated_score_norm: z.number() })
          ),
          url: z.string(),
          beforeConfirmation: z.boolean(),
          ruleEnabled: z.boolean(),
          previewId: z.string(),
          asyncExecutionId: z.string(),
        }),
        handler: async (context) => {
          const request = context.contextManager.getFakeRequest();
          const agentBuilder = services.getService<AgentBuilderPluginStart>('agentBuilder');
          await agentBuilder.skills.getRegistry({ request });
          const risk = await agentBuilder.tools.execute({
            request,
            toolId: SECURITY_ENTITY_RISK_SCORE_TOOL_ID,
            toolParams: { identifierType: 'host', identifier: '*' },
          });
          const navigation = await agentBuilder.tools.execute({
            request,
            toolId: SECURITY_BUILD_REDIRECT_URL_TOOL_ID,
            toolParams: { path: '/app/security/alerts' },
          });
          const riskResult = risk.results?.[0];
          const navigationResult = navigation.results?.[0];
          if (
            riskResult?.type !== ToolResultType.other ||
            navigationResult?.type !== ToolResultType.other
          )
            throw new Error(
              `Native Security tools failed: ${JSON.stringify({ risk, navigation })}`
            );
          const { riskScores } = z
            .object({
              riskScores: z.array(
                z.object({ id_value: z.string(), calculated_score_norm: z.number() })
              ),
            })
            .parse(riskResult.data);
          const { url } = z.object({ url: z.string() }).parse(navigationResult.data);
          const readRule = async (): Promise<boolean> => {
            const read = await agentBuilder.tools.execute({
              request,
              toolId: SECURITY_LIST_RESOLUTION_RULES_TOOL_ID,
              toolParams: {},
            });
            const result = read.results?.[0];
            if (result?.type !== ToolResultType.other)
              throw new Error(`Native resolution read failed: ${JSON.stringify(read)}`);
            const { rules } = z
              .object({
                rules: z.array(z.object({ id: z.string(), enabled: z.boolean() })),
              })
              .parse(result.data);
            const rule = rules.find(({ id }) => id === 'email_exact_match');
            if (!rule) throw new Error('The native resolution catalog is missing email matching');
            return rule.enabled;
          };
          const update = {
            request,
            toolId: SECURITY_SET_RESOLUTION_RULES_TOOL_ID,
            toolCallId: 'native-resolution-update',
            toolParams: { rules: [{ ruleId: 'email_exact_match', enabled: false }] },
          };
          const proposed = await agentBuilder.tools.execute(update);
          const declined = proposed.results?.[0];
          if (
            declined?.type !== ToolResultType.error ||
            z.object({ metadata: z.object({ declined_reason: z.string() }) }).parse(declined.data)
              .metadata.declined_reason !== 'non_interactive'
          )
            throw new Error(
              `Native standalone writes must decline without confirmation: ${JSON.stringify(
                proposed
              )}`
            );
          const beforeConfirmation = await readRule();
          const confirmed = await agentBuilder.tools.execute({
            ...update,
            promptState: {
              responses: {
                [`resolution.set_resolution_rules.${update.toolCallId}`]: {
                  type: AgentPromptType.confirmation,
                  response: { allow: true },
                },
              },
            },
          });
          if (confirmed.results?.[0]?.type !== ToolResultType.other)
            throw new Error(`Native resolution write failed: ${JSON.stringify(confirmed)}`);
          const preview = await agentBuilder.tools.execute({
            request,
            toolId: SECURITY_RUN_RULE_PREVIEW_TOOL_ID,
            toolParams: {
              command: 'query --query "*" --index native-security-preview-docs --language kuery',
            },
          });
          const previewResult = preview.results?.[0];
          if (previewResult?.type !== ToolResultType.other)
            throw new Error(`Native rule preview failed: ${JSON.stringify(preview)}`);
          const { previewId, logs } = z
            .object({
              previewId: z.string(),
              logs: z.array(z.object({ errors: z.array(z.string()) })),
            })
            .parse(previewResult.data);
          if (logs.some(({ errors }) => errors.length))
            throw new Error(`Native preview executor failed: ${JSON.stringify(logs)}`);
          const scheduled = await agentBuilder.execution.executeAgent({
            request,
            mode: AgentExecutionMode.conversation,
            useTaskManager: true,
            params: {
              agentId: agentBuilderDefaultAgentId,
              nextInput: { message: 'Queue a native agent execution' },
            },
          });
          return {
            output: {
              riskScores,
              url,
              beforeConfirmation,
              ruleEnabled: await readRule(),
              previewId,
              asyncExecutionId: scheduled.executionId,
            },
          };
        },
      })
    );
  },
};
