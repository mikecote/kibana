/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

const fs = require('fs');
const path = require('path');
const { parse, stringify } = require('yaml');

const LIMITS_PATH = path.join(__dirname, 'limits.yml');
const HEADROOM = 1.1;
const MAX_INCREASE = 1.15;

/** { bundleBytes: { <bundle>: bytes }, rssMb: { <bundle>: MB } } */
const readLimits = (file = LIMITS_PATH) =>
  fs.existsSync(file) ? parse(fs.readFileSync(file, 'utf8')) ?? {} : {};

/**
 * Checks built bundles against their byte limits. A bundle without a limit, or a limit without a
 * bundle, is an error, so a new task type is always added to limits.yml in the same change.
 */
const validateBundleLimits = (results, limits = readLimits()) => {
  const bytes = limits.bundleBytes ?? {};
  const errors = [];
  for (const { name, bytes: size } of results) {
    if (bytes[name] === undefined) errors.push(`${name} has no limit; run --update-limits`);
    else if (size > bytes[name]) {
      errors.push(`${name} is ${size} bytes, over its limit of ${bytes[name]}`);
    }
  }
  for (const name of Object.keys(bytes)) {
    if (!results.some((r) => r.name === name)) errors.push(`${name} has a limit but no bundle`);
  }
  return errors;
};

/** Rewrites limits to the measured size plus headroom; refuses large increases without `force`. */
const updateBundleLimits = (results, { force = false, file = LIMITS_PATH } = {}) => {
  const limits = readLimits(file);
  const bytes = {};
  const errors = [];
  for (const { name, bytes: size } of results) {
    const previous = limits.bundleBytes?.[name];
    if (previous !== undefined && size <= previous) {
      bytes[name] = previous;
      continue;
    }
    const next = Math.ceil((size * HEADROOM) / 1000) * 1000;
    if (previous !== undefined && next > previous * MAX_INCREASE && !force) {
      errors.push(`${name} grew from ${previous} to ${next}; pass --force if that is intended`);
    }
    bytes[name] = next;
  }
  if (errors.length) return errors;
  const sorted = Object.fromEntries(Object.entries(bytes).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(file, stringify({ ...limits, bundleBytes: sorted }));
  return [];
};

module.exports = { LIMITS_PATH, readLimits, validateBundleLimits, updateBundleLimits };
