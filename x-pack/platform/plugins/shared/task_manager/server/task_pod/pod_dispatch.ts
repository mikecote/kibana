/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { PodRoute } from './remote_task_runner';

export interface PodDispatch {
  getPod(taskType: string): PodRoute | undefined;
  /** Routes task types to a pod at runtime (Kibana-managed processes); returns how to remove it. */
  addRoute(route: PodConfig): () => void;
  kibanaVersion: string;
}

export interface PodConfig {
  url: string;
  task_types: string[];
  /** Shared secret the pod expects as a bearer token on `/run` and `/cancel`. */
  token?: string;
}

const globToRegExp = (glob: string) =>
  new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);

/** Routes task types to pods by glob, first matching pod wins. No pods configured = all local. */
export const createPodDispatch = ({
  pods = [],
  kibanaVersion,
}: {
  pods?: PodConfig[];
  kibanaVersion: string;
}): PodDispatch => {
  const toMatcher = (pod: PodConfig) => ({ pod, patterns: pod.task_types.map(globToRegExp) });
  const matchers = pods.map(toMatcher);
  return {
    kibanaVersion,
    getPod: (taskType) => {
      const match = matchers.find(({ patterns }) => patterns.some((p) => p.test(taskType)));
      return match
        ? {
            url: match.pod.url.replace(/\/$/, ''),
            ...(match.pod.token ? { token: match.pod.token } : {}),
          }
        : undefined;
    },
    addRoute: (pod) => {
      const matcher = toMatcher(pod);
      matchers.push(matcher);
      return () => {
        const index = matchers.indexOf(matcher);
        if (index >= 0) matchers.splice(index, 1);
      };
    },
  };
};
