/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

/** Applies only Main's instrumentation environment before loading the native SDKs. */
export const applyTaskProcessInstrumentationEnvironment = (
  environment: Readonly<Record<string, string>>
): void => {
  if (!environment) throw new Error('Native instrumentation requires the dispatch environment');
  const isInstrumentationKey = (key: string): boolean => /^(ELASTIC_APM_|OTEL_)/.test(key);
  if (Object.keys(environment).some((key) => !isInstrumentationKey(key))) {
    throw new Error('Instrumentation metadata contains an unrelated environment variable');
  }
  for (const key of Object.keys(process.env)) {
    if (isInstrumentationKey(key)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(environment)) process.env[key] = value;
};
