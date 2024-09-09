/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { Logger, LogMessageSource, LogMeta } from '@kbn/logging';

export function wrapLoggerWithTags(logger: Logger, tags: string[]): Logger {
  return {
    ...logger,
    trace<Meta extends LogMeta = LogMeta>(message: LogMessageSource, meta?: Meta) {
      logger.trace(message, extendMeta(tags, meta));
    },
    debug<Meta extends LogMeta = LogMeta>(message: LogMessageSource, meta?: Meta) {
      logger.debug(message, extendMeta(tags, meta));
    },
    info<Meta extends LogMeta = LogMeta>(message: LogMessageSource, meta?: Meta) {
      logger.info(message, extendMeta(tags, meta));
    },
    warn<Meta extends LogMeta = LogMeta>(errorOrMessage: LogMessageSource | Error, meta?: Meta) {
      logger.warn(errorOrMessage, extendMeta(tags, meta));
    },
    error<Meta extends LogMeta = LogMeta>(errorOrMessage: LogMessageSource | Error, meta?: Meta) {
      logger.error(errorOrMessage, extendMeta(tags, meta));
    },
    fatal<Meta extends LogMeta = LogMeta>(errorOrMessage: LogMessageSource | Error, meta?: Meta) {
      logger.fatal(errorOrMessage, extendMeta(tags, meta));
    },
  };
}

function extendMeta<Meta extends LogMeta = LogMeta>(tags: string[], meta?: Meta) {
  return {
    ...(meta || {}),
    tags: meta?.tags ? tags.concat(meta.tags) : tags,
  };
}
