/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

/**
 * Makes a task process that Kibana forked end with its parent. A forked child whose parent was
 * killed (SIGKILL, an OOM kill) has nobody to tell it to stop: the IPC channel closes (`disconnect`)
 * and, as a backstop for a channel that does not report it, the parent pid changes.
 */
export const watchParent = ({
  onParentGone,
  pollMs = 2000,
  getParentPid = () => process.ppid,
  events = process,
}: {
  onParentGone: (reason: 'disconnect' | 'parent_pid_changed') => void;
  pollMs?: number;
  getParentPid?: () => number;
  events?: { once: (event: 'disconnect', listener: () => void) => unknown };
}) => {
  let gone = false;
  const handle = (reason: 'disconnect' | 'parent_pid_changed') => {
    if (gone) return;
    gone = true;
    clearInterval(timer);
    onParentGone(reason);
  };
  const initialPid = getParentPid();
  events.once('disconnect', () => handle('disconnect'));
  const timer = setInterval(() => {
    if (getParentPid() !== initialPid) handle('parent_pid_changed');
  }, pollMs);
  // The server keeps the process alive; this must not.
  (timer as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
};

/** Watches the parent before initialization and binds native shutdown once Core has started. */
export const createTaskProcessParentWatcher = (): ((stop: () => Promise<void>) => void) => {
  let stopCore: (() => Promise<void>) | undefined;
  if (process.send) {
    watchParent({
      onParentGone: (reason) => {
        process.stderr.write(`Task process stopping: its parent is gone (${reason})\n`);
        const forceExit = setTimeout(() => process.exit(1), 5000);
        forceExit.unref();
        (stopCore?.() ?? Promise.resolve()).finally(() => process.exit(0));
      },
    });
  }
  return (stop) => {
    stopCore = stop;
  };
};
