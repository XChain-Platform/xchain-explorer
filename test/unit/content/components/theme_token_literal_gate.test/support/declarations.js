// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const { stripComments } = require('./helpers.js');

function lineAt(text, offset) {
  let n = 1;
  for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

// Flat block parser: matching innermost `selector { body }` blocks also reaches
// one level of @media wrapping in theme-owned component sheets. Declaration
// offsets are tracked with a running cursor (not body.indexOf(decl)) because
// several declarations repeat verbatim (e.g. the border-width-none reset),
// and indexOf would always resolve to the first occurrence.
function parseDeclarations(rawCss, fileName) {
  const css = stripComments(rawCss);
  const decls = [];
  const blockRe = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = blockRe.exec(css))) {
    const selector = m[1].trim().replace(/\s+/g, ' ');
    let cursor = m.index + m[1].length + 1; // offset just past the '{'
    for (const raw of m[2].split(';')) {
      const start = cursor;
      cursor += raw.length + 1; // +1 for the ';' consumed by split
      const decl = raw.trim();
      const colon = decl.indexOf(':');
      if (!decl || colon === -1) continue;
      decls.push({
        file: fileName,
        selector,
        property: decl.slice(0, colon).trim().toLowerCase(),
        value: decl.slice(colon + 1).replace(/!important\s*$/i, '').trim(),
        line: lineAt(css, start),
      });
    }
  }
  return decls;
}

// The declarations of one gated sheet that the literal check reads. A theme's
// tokens.css is where custom properties are DEFINED, so a `--*` declaration
// there is the definition the gate wants literals to live in; every ordinary
// rule in the same file is checked like any other sheet. The skip is scoped to
// tokens.css because a custom property declared in another sheet (the `--bs-*`
// button variables in xchain-charts.css) must still be checked for literals.
function literalDeclarations(sheet) {
  const decls = parseDeclarations(sheet.raw, sheet.name);
  return sheet.tokens ? decls.filter((d) => !d.property.startsWith('--')) : decls;
}

module.exports = { parseDeclarations, literalDeclarations };
