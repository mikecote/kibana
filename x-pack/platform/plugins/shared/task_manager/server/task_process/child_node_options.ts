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
 * The young generation (`--max-semi-space-size`) of a process, in MB. Node's default lets the young
 * generation grow to 128 MB resident, which a process that lives for one run never needs (measured on
 * idle processes: a 2 MB semi space takes 63 to 117 MB off their resident memory, with startup unchanged
 * and about 7% more CPU in allocation-heavy work). `child_max_semi_space_mb` overrides it.
 */
export const DEFAULT_CHILD_MAX_SEMI_SPACE_MB = 2;

/**
 * What a child process is started with: Kibana's `execArgv` and `NODE_OPTIONS` without the
 * inspector and heap flags, the heap size configured for children, if any, and the size of their young
 * generation.
 */
export const getChildNodeOptions = ({
  execArgv = process.execArgv,
  nodeOptions = process.env.NODE_OPTIONS,
  maxOldSpaceMb,
  maxSemiSpaceMb = DEFAULT_CHILD_MAX_SEMI_SPACE_MB,
}: {
  execArgv?: readonly string[];
  nodeOptions?: string;
  maxOldSpaceMb?: number;
  maxSemiSpaceMb?: number;
} = {}): { execArgv: string[]; nodeOptions: string | undefined } => ({
  execArgv: [
    ...filterNodeArgs(execArgv),
    ...(maxOldSpaceMb ? [`--max-old-space-size=${maxOldSpaceMb}`] : []),
    `--max-semi-space-size=${maxSemiSpaceMb}`,
  ],
  nodeOptions: filterNodeOptions(nodeOptions),
});
