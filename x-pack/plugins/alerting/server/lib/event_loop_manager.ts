/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

export class EventLoopManager {
  private threshold: number;
  private lastEventLoopRelease: number;
  constructor(threshold: number = 50) {
    this.threshold = threshold;
    this.lastEventLoopRelease = Date.now();
  }

  async releaseEventLoopIfNecessary() {
    if (Date.now() - this.lastEventLoopRelease > this.threshold) {
      await new Promise((resolve) => setImmediate(resolve));
      this.lastEventLoopRelease = Date.now();
    }
  }
}
