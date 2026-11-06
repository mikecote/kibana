/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

/**
 * Node flags a task process must not inherit from Kibana: the inspector (two processes cannot
 * share Kibana's port, and a debugger attached to every child is never wanted) and heap sizing
 * (Kibana is sized for a whole server; a child that runs one task is not).
 */
const DROPPED_FLAGS = [
  /^--inspect(-brk|-wait|-port|-publish-uid)?$/,
  /^--debug(-brk|-port)?$/,
  /^--max[-_]old[-_]space[-_]size$/,
  /^--max[-_]heap[-_]size$/,
  /^--max[-_]semi[-_]space[-_]size$/,
  /^--initial[-_]heap[-_]size$/,
  /^--initial[-_]old[-_]space[-_]size$/,
  /^--heapsnapshot[-_].*$/,
];

const isDropped = (flag: string) => DROPPED_FLAGS.some((pattern) => pattern.test(flag));

/** Drops the inspector and heap flags of a list of node arguments, with a separate value if any. */
export const filterNodeArgs = (args: readonly string[]): string[] => {
  const kept: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const [flag, ...rest] = arg.split('=');
    if (!arg.startsWith('--') || !isDropped(flag)) {
      kept.push(arg);
      continue;
    }
    // `--max-old-space-size 4096`: the value is the next argument.
    if (rest.length === 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('-')) i++;
  }
  return kept;
};

/** `NODE_OPTIONS` without the inspector and heap flags. Undefined when nothing is left. */
export const filterNodeOptions = (nodeOptions: string | undefined): string | undefined => {
  if (!nodeOptions) return undefined;
  // NODE_OPTIONS has no quoting rules beyond double quotes; flags worth dropping have no spaces.
  const filtered = filterNodeArgs(nodeOptions.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []).join(' ');
  return filtered || undefined;
};

/**
 * What a child process is started with: Kibana's `execArgv` and `NODE_OPTIONS` without the
 * inspector and heap flags, and the heap size configured for children, if any.
 */
export const getChildNodeOptions = ({
  execArgv = process.execArgv,
  nodeOptions = process.env.NODE_OPTIONS,
  maxOldSpaceMb,
}: {
  execArgv?: readonly string[];
  nodeOptions?: string;
  maxOldSpaceMb?: number;
} = {}): { execArgv: string[]; nodeOptions: string | undefined } => ({
  execArgv: [
    ...filterNodeArgs(execArgv),
    ...(maxOldSpaceMb ? [`--max-old-space-size=${maxOldSpaceMb}`] : []),
  ],
  nodeOptions: filterNodeOptions(nodeOptions),
});
