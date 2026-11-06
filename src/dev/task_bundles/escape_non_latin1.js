/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

/**
 * Escapes every character above U+00FF in the text of a bundle as `\uXXXX`.
 *
 * V8 keeps the source of a script in memory for as long as the script lives (to compile its functions
 * lazily), as one byte per character when every character is Latin-1 and as two bytes per character as
 * soon as one is not. A single `/〇/` in a regex of a dependency doubled the resident source of a bundle:
 * 29 MB instead of 15 MB for a 14.7 MB bundle, and about 60 MB for a 29.6 MB one. esbuild only escapes
 * what is outside a regular expression, so the escape runs on its output.
 *
 * `\uXXXX` means the same thing in a regular expression (with or without the `u` flag), a string, a
 * template literal (but for a raw one, which no code of a bundle has these characters in), an identifier
 * and a comment. Characters above U+FFFF are escaped as their two surrogates, which a `u` regex reads as
 * the one character again. The source map of the bundle only shifts columns in the lines that change.
 */
const escapeNonLatin1 = (text) =>
  text.replace(/[^\x00-\xff]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);

/** Whether a text is stored with one byte per character by V8: every character is Latin-1. */
const isLatin1 = (text) => !/[^\x00-\xff]/.test(text);

module.exports = { escapeNonLatin1, isLatin1 };
