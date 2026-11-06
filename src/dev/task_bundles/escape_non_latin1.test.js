/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

const { escapeNonLatin1, isLatin1 } = require('./escape_non_latin1');

const vm = require('vm');

const evaluate = (code) => vm.runInNewContext(code);

describe('escapeNonLatin1', () => {
  it('leaves text of Latin-1 characters alone', () => {
    const text = 'const a = "é ß ÿ"; // ASCII and ÿ';
    expect(escapeNonLatin1(text)).toBe(text);
    expect(isLatin1(text)).toBe(true);
  });

  it('escapes what is above U+00FF so that V8 stores the source with one byte per character', () => {
    const escaped = escapeNonLatin1('/〇/.test(s) + "…" + ẞ');
    expect(escaped).toBe('/\\u3007/.test(s) + "\\u2026" + \\u1e9e');
    expect(isLatin1(escaped)).toBe(true);
    expect(isLatin1('/〇/')).toBe(false);
  });

  it('means the same in a regular expression, with and without the u flag', () => {
    const source = '[/^[〇・]+$/.test("〇・"), /^[\\p{L}・]+$/u.test("a・"), /ẞ/g.test("ẞ")]';
    expect(evaluate(escapeNonLatin1(source))).toEqual(evaluate(source));
    expect(evaluate(escapeNonLatin1(source))).toEqual([true, true, true]);
  });

  it('means the same in strings, template literals and identifiers', () => {
    const source = '(() => { const π = "…"; return [`${π}〇`, "ẞ" + π]; })()';
    expect(evaluate(escapeNonLatin1(source))).toEqual(evaluate(source));
  });

  it('keeps a character above U+FFFF as the same character, also in a u regex', () => {
    const source = '[/^😀$/u.test("😀"), "😀".length, [..."😀"].length, /^[😀]$/u.test("😀")]';
    const escaped = escapeNonLatin1(source);
    expect(isLatin1(escaped)).toBe(true);
    expect(evaluate(escaped)).toEqual(evaluate(source));
  });
});
