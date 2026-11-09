/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

interface ChatRequest {
  messages: Array<{ role: string; content?: string }>;
  tools?: Array<{ function: { name: string } }>;
  tool_choice?: string | { function?: { name?: string } };
  stream?: boolean;
}

interface WorkflowLlmStub {
  url: string;
  requests: ChatRequest[];
  stop: () => Promise<void>;
}

/** Answers with a real index-listing tool call, then the supplied final response. */
export const startWorkflowLlmStub = async (
  index: string,
  finalAnswer: string
): Promise<WorkflowLlmStub> => {
  const requests: ChatRequest[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      const chat = JSON.parse(body) as ChatRequest;
      requests.push(chat);
      const system = chat.messages.find(({ role }) => role === 'system')?.content ?? '';
      const choice = typeof chat.tool_choice === 'object' ? chat.tool_choice.function?.name : '';
      const title = choice === 'set_title' || system.includes('You are a title-generation utility');
      const tool = chat.tools?.find(({ function: { name } }) => name.includes('list_indices'));
      const toolName = title
        ? 'set_title'
        : chat.messages.some(({ role }) => role === 'tool')
        ? undefined
        : tool?.function.name;
      const delta = toolName
        ? {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'native-index-list',
                type: 'function',
                function: {
                  name: toolName,
                  arguments: JSON.stringify(
                    title ? { title: 'Native indices' } : { pattern: index }
                  ),
                },
              },
            ],
          }
        : { role: 'assistant', content: finalAnswer };
      const base = { id: 'native-chat', created: 1, model: 'gpt-4' };
      const finishReason = toolName ? 'tool_calls' : 'stop';
      if (chat.stream) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(
          `data: ${JSON.stringify({
            ...base,
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta, finish_reason: null }],
          })}\n\n`
        );
        response.write(
          `data: ${JSON.stringify({
            ...base,
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
            usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 },
          })}\n\n`
        );
        response.end('data: [DONE]\n\n');
      } else {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            ...base,
            object: 'chat.completion',
            choices: [{ index: 0, message: delta, finish_reason: finishReason }],
            usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 },
          })
        );
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    stop: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      ),
  };
};
