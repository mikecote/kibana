/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { EventEmitter } from 'events';
import { watchParent } from './parent_watch';

describe('watchParent', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('stops the process when the fork channel disconnects', () => {
    const events = new EventEmitter();
    const onParentGone = jest.fn();
    watchParent({ onParentGone, events, getParentPid: () => 10 });
    events.emit('disconnect');
    events.emit('disconnect');
    expect(onParentGone).toHaveBeenCalledTimes(1);
    expect(onParentGone).toHaveBeenCalledWith('disconnect');
  });

  it('stops the process when the parent pid changes', () => {
    const events = new EventEmitter();
    const onParentGone = jest.fn();
    let pid = 10;
    watchParent({ onParentGone, events, getParentPid: () => pid, pollMs: 100 });
    jest.advanceTimersByTime(300);
    expect(onParentGone).not.toHaveBeenCalled();
    pid = 1;
    jest.advanceTimersByTime(100);
    expect(onParentGone).toHaveBeenCalledWith('parent_pid_changed');
    jest.advanceTimersByTime(1000);
    expect(onParentGone).toHaveBeenCalledTimes(1);
  });
});
