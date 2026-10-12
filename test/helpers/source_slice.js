/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * The one slicer suites use to lift a shipped function out of a source text,
 * so a test runs the shipped body rather than a copy of it that can drift.
 *
 * Braces are counted plainly, strings and comments included, and a walk that
 * never balances throws instead of returning the rest of the file.
 */

'use strict';

/**
 * Slice from the first occurrence of `needle` through the brace that closes the
 * first `{` after it.
 *
 * @param {string} src     the source text to slice from
 * @param {string} needle  the text the slice starts at, e.g. 'function(o)'
 * @param {string} [where] a name for the source, used only in error messages
 * @returns {string}
 */
function extractBlock(src, needle, where){
    const label = where || 'source';
    const start = src.indexOf(needle);
    if(start < 0) throw new Error('not found in ' + label + ': ' + needle);
    const braceStart = src.indexOf('{', start);
    if(braceStart < 0) throw new Error('no opening brace after ' + needle + ' in ' + label);
    let depth = 0;
    for(let i = braceStart; i < src.length; i++){
        if(src[i] === '{') depth++;
        else if(src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
    }
    throw new Error('unterminated block after ' + needle + ' in ' + label);
}

/**
 * Slice the first `function name(...) { ... }` out of a source text.
 *
 * @param {string} src     the source text to slice from
 * @param {string} name    the function's name
 * @param {string} [where] a name for the source, used only in error messages
 * @returns {string}
 */
function extractFn(src, name, where){
    const sig = 'function ' + name + '(';
    if(src.indexOf(sig) < 0) throw new Error('function not found in ' + (where || 'source') + ': ' + name);
    return extractBlock(src, sig, where);
}

module.exports = { extractBlock, extractFn };
