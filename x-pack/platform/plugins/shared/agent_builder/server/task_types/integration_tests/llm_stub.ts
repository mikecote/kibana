/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

/* eslint-disable @typescript-eslint/no-non-null-assertion, @typescript-eslint/no-explicit-any */
import { createServer } from 'http';
import type { Server } from 'http';
import type { AddressInfo } from 'net';

export const FINAL_ANSWER = 'Done.';

export interface ChatRequest {
  messages: Array<{ role: string; content?: unknown; tool_calls?: unknown[] }>;
  tools?: Array<{ function: { name: string } }>;
  tool_choice?: unknown;
  stream?: boolean;
}

// The names the model sees: ids with the characters it does not take replaced.
export const modelName = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, '_');
export const outputOf = (step: any) => step.output.output ?? step.output;
export const call = (toolId: string, args: Record<string, unknown>) =>
  `CALL ${toolId} ${JSON.stringify(args)}`;
/** Loads the skill that gives the agent the tool, as an agent does, and then calls the tool. */
export const withSkill = (skill: string, toolCall: string) =>
  `${call('load_skill', { skill })}\n${toolCall}`;

const toolCallChunk = (name: string, args: Record<string, unknown>, id = 'call_1') => ({
  choices: [
    {
      index: 0,
      delta: {
        role: 'assistant',
        tool_calls: [
          { index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } },
        ],
      },
      finish_reason: null,
    },
  ],
});

const answerTo = (request: ChatRequest) => {
  const system = String(request.messages.find(({ role }) => role === 'system')?.content ?? '');
  const toolChoice = (request.tool_choice as { function?: { name?: string } } | undefined)?.function
    ?.name;
  if (toolChoice === 'set_title' || system.includes('You are a title-generation utility')) {
    return toolCallChunk('set_title', { title: 'A tool call' });
  }
  const lastUser = [...request.messages].reverse().find(({ role }) => role === 'user')?.content;
  const text = typeof lastUser === 'string' ? lastUser : JSON.stringify(lastUser);
  // The calls the message asks for, one per line, made in order: the number of results the model has
  // received is the number of calls made.
  const calls = [...String(text).matchAll(/CALL (\S+) (\{[^\n]*\})/g)].map(([, toolId, json]) => ({
    toolId,
    args: JSON.parse(json),
  }));
  const made = request.messages.filter(({ role }) => role === 'tool').length;
  const next = calls[made];
  if (next) {
    const tool = request.tools?.find(({ function: { name } }) => name === modelName(next.toolId));
    // A tool the model is not offered cannot be called: it answers without it, and the test fails.
    if (tool) return toolCallChunk(tool.function.name, next.args, `call_${made + 1}`);
  }
  return {
    choices: [
      { index: 0, delta: { role: 'assistant', content: FINAL_ANSWER }, finish_reason: null },
    ],
  };
};

/**
 * A stub of an OpenAI-compatible LLM: the message of the `ai.agent` step tells it which tools to call
 * (`CALL <tool id> <json arguments>`, one per line), and it answers `FINAL_ANSWER` once it has.
 */
export const startLlmStub = async () => {
  const requests: ChatRequest[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const request = JSON.parse(body || '{}') as ChatRequest;
      requests.push(request);
      const base = { id: 'chatcmpl-1', created: 1, model: 'gpt-4' };
      const chunk = answerTo(request);
      const finish =
        (chunk.choices[0].delta as { content?: string }).content === FINAL_ANSWER
          ? 'stop'
          : 'tool_calls';
      const usage = { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 };
      if (request.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(
          `data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', ...chunk })}\n\n`
        );
        res.write(
          `data: ${JSON.stringify({
            ...base,
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: {}, finish_reason: finish }],
            usage,
          })}\n\n`
        );
        res.end('data: [DONE]\n\n');
      } else {
        const { delta } = chunk.choices[0];
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            ...base,
            object: 'chat.completion',
            choices: [{ index: 0, message: delta, finish_reason: finish }],
            usage,
          })
        );
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    /** What the tools answered the model, from the requests the stub received since `from`. */
    toolResultsSince: (from: number) =>
      requests
        .slice(from)
        .flatMap(({ messages }) => messages.filter(({ role }) => role === 'tool'))
        .map(({ content }) => (typeof content === 'string' ? content : JSON.stringify(content)))
        .join('\n'),
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
};
