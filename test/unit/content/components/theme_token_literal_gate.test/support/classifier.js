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

function tokenizeValue(value) {
  const tokens = [];
  let depth = 0;
  let cur = '';
  for (const ch of value) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (depth === 0 && /[\s,]/.test(ch)) {
      if (cur) tokens.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur) tokens.push(cur);
  return tokens;
}

const HEX_RE = /^#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})$/;
const FUNC_COLOR_RE = /^(rgba?|hsla?)\(/i;
const VAR_RE = /^var\(\s*(--[\w-]+)/i;
const NUMERIC_RE = /^-?(?:\d+\.?\d*|\.\d+)(px|em|rem|%|vh|vw|vmin|vmax|deg|s|ms|q|cm|mm|in|pt|pc|ex|ch|fr)?$/i;

const NAMED_COLOR_WORDS = new Set([
  'aliceblue', 'antiquewhite', 'aqua', 'aquamarine', 'azure', 'beige', 'bisque', 'black',
  'blanchedalmond', 'blue', 'blueviolet', 'brown', 'burlywood', 'cadetblue', 'chartreuse',
  'chocolate', 'coral', 'cornflowerblue', 'cornsilk', 'crimson', 'cyan', 'darkblue', 'darkcyan',
  'darkgoldenrod', 'darkgray', 'darkgreen', 'darkgrey', 'darkkhaki', 'darkmagenta',
  'darkolivegreen', 'darkorange', 'darkorchid', 'darkred', 'darksalmon', 'darkseagreen',
  'darkslateblue', 'darkslategray', 'darkslategrey', 'darkturquoise', 'darkviolet', 'deeppink',
  'deepskyblue', 'dimgray', 'dimgrey', 'dodgerblue', 'firebrick', 'floralwhite', 'forestgreen',
  'fuchsia', 'gainsboro', 'ghostwhite', 'gold', 'goldenrod', 'gray', 'green', 'greenyellow',
  'grey', 'honeydew', 'hotpink', 'indianred', 'indigo', 'ivory', 'khaki', 'lavender',
  'lavenderblush', 'lawngreen', 'lemonchiffon', 'lightblue', 'lightcoral', 'lightcyan',
  'lightgoldenrodyellow', 'lightgray', 'lightgreen', 'lightgrey', 'lightpink', 'lightsalmon',
  'lightseagreen', 'lightskyblue', 'lightslategray', 'lightslategrey', 'lightsteelblue',
  'lightyellow', 'lime', 'limegreen', 'linen', 'magenta', 'maroon', 'mediumaquamarine',
  'mediumblue', 'mediumorchid', 'mediumpurple', 'mediumseagreen', 'mediumslateblue',
  'mediumspringgreen', 'mediumturquoise', 'mediumvioletred', 'midnightblue', 'mintcream',
  'mistyrose', 'moccasin', 'navajowhite', 'navy', 'oldlace', 'olive', 'olivedrab', 'orange',
  'orangered', 'orchid', 'palegoldenrod', 'palegreen', 'paleturquoise', 'palevioletred',
  'papayawhip', 'peachpuff', 'peru', 'pink', 'plum', 'powderblue', 'purple', 'rebeccapurple',
  'red', 'rosybrown', 'royalblue', 'saddlebrown', 'salmon', 'sandybrown', 'seagreen', 'seashell',
  'sienna', 'silver', 'skyblue', 'slateblue', 'slategray', 'slategrey', 'snow', 'springgreen',
  'steelblue', 'tan', 'teal', 'thistle', 'tomato', 'turquoise', 'violet', 'wheat', 'white',
  'whitesmoke', 'yellow', 'yellowgreen', 'transparent', 'currentcolor',
]);

// Physical and logical spacing/size properties are covered. Positioning
// offsets stay excluded because their numbers are structural, not theme values.
const SPACING_PROPS = new Set([
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'padding-inline', 'padding-inline-start', 'padding-inline-end',
  'padding-block', 'padding-block-start', 'padding-block-end',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'margin-inline', 'margin-inline-start', 'margin-inline-end',
  'margin-block', 'margin-block-start', 'margin-block-end',
  'font-size', 'letter-spacing', 'line-height', 'gap', 'row-gap', 'column-gap',
  'border-width', 'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'border-inline-width', 'border-block-width', 'border-inline-start-width', 'border-inline-end-width',
  'border-block-start-width', 'border-block-end-width',
  'border', 'border-top', 'border-right', 'border-bottom', 'border-left', 'outline',
  'border-inline', 'border-block', 'border-inline-start', 'border-inline-end',
  'border-block-start', 'border-block-end',
  'height', 'width', 'min-height', 'max-height', 'min-width', 'max-width',
  'inline-size', 'block-size', 'min-inline-size', 'max-inline-size', 'min-block-size', 'max-block-size',
]);
const FULL_BLEED_PROPS = new Set([
  'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height',
  'inline-size', 'block-size', 'min-inline-size', 'max-inline-size', 'min-block-size', 'max-block-size',
]);
const BOOTSTRAP_SIZE_RE = /^--bs-(?:[a-z0-9]+-)*(?:padding(?:-[xy])?|margin(?:-[xy])?|font-size|gap|gutter-[xy]|border-width|letter-spacing|line-height)$/;

const ALLOWLIST = [
  {
    match: (d) => d.property === 'background-image' && /^url\(/i.test(d.value),
  },
  {
    match: (d) => d.file === 'xchain-charts.css' && d.selector === '.xc-chart-tooltip'
      && d.property === 'opacity' && d.value === '0',
  },
];

const OPAQUE_FUNC_RE = /^(?:var|url|rgba?|hsla?)\(/i;
const CALL_RE = /^([a-zA-Z][\w-]*)\((.*)\)$/s;

function flattenTokens(value, depth = 0) {
  const out = [];
  for (const token of tokenizeValue(value)) {
    out.push(token);
    if (depth >= 8 || OPAQUE_FUNC_RE.test(token)) continue;
    const call = CALL_RE.exec(token);
    if (call) out.push(...flattenTokens(call[2], depth + 1));
  }
  return out;
}

function isSpacingProperty(property) {
  return SPACING_PROPS.has(property) || BOOTSTRAP_SIZE_RE.test(property);
}

function classifyViolation(d) {
  if (ALLOWLIST.some((rule) => rule.match(d))) return null;
  let sawColor = false;
  let sawNumeric = false;
  for (const token of flattenTokens(d.value)) {
    if (VAR_RE.test(token)) continue;
    if (HEX_RE.test(token) || FUNC_COLOR_RE.test(token) || NAMED_COLOR_WORDS.has(token.toLowerCase())) {
      sawColor = true;
      continue;
    }
    if (NUMERIC_RE.test(token)) sawNumeric = true;
  }
  if (sawColor) return 'color';
  if (!sawNumeric) return null;
  if (/radius/.test(d.property)) return 'radius';
  if (d.property === 'box-shadow' || d.property === 'text-shadow') return 'shadow';
  if (!isSpacingProperty(d.property)) return null;
  if (FULL_BLEED_PROPS.has(d.property) && d.value.trim() === '100%') return null;
  return 'spacing';
}

module.exports = { classifyViolation, isSpacingProperty };
