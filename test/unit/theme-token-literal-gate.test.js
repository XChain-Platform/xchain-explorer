const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Static companion to tools/theme-parity/parity-probe.js. That probe diffs
// computed styles on live pages, but only 77 of the 121 selectors in these
// two stylesheets are ever instantiated by a page it can capture; the other
// 44 render on no path it drives. This gate covers all 121 by reading the
// stylesheet text instead of a rendered page, so it catches a reintroduced
// literal on a selector the probe never sees. The two are complementary,
// not redundant: the probe proves a token swap actually repaints pixels,
// this gate proves nothing was left behind for it to miss.
const CSS_DIR = path.join(__dirname, '..', '..', 'src', 'content', 'css');
const TOKENS_FILE = path.join(__dirname, '..', '..', 'src', 'content', 'themes', 'classic', 'tokens.css');
const CSS_FILES = ['xchain.css', 'xchain-charts.css'];

// Strip /* ... */ comments but keep every newline, so a later offset-to-line
// count still lines up with the original file. A commented-out declaration
// (xchain.css carries two, both legacy hex colors) must not be scanned.
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

function lineAt(text, offset) {
  let n = 1;
  for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

// Flat block parser: neither stylesheet nests rules or uses @media, so
// matching `selector { body }` at the top level is sufficient. Declaration
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

// Value tokenizer: splits on whitespace/commas at paren-depth 0, so
// `var(--xc-foo, #ced4da)` and `rgba(0, 0, 0, .18)` stay one token each.
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

// CSS Color Module named color keywords, checked as whole tokens only so
// unrelated keywords (nowrap, collapse, capitalize, ellipsis, fixed, both,
// none, auto) never collide with a real color word.
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

// Property families that carry the spacing/size design decisions the spec
// names: padding, margin, font-size, border-width, letter-spacing,
// line-height, height/width. Border shorthands are included so a literal
// width buried in `border: 1px solid ...` is not missed. top/right/bottom/
// left/z-index/content are deliberately excluded: on this tree they are
// positioning offsets that already read from tokens where a design
// decision exists (glyph-offset-top etc.), never a bare theme literal, and
// a naive gate that caught every number in the file would be useless noise
// rather than a signal a reviewer could act on.
const SPACING_PROPS = new Set([
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'font-size', 'letter-spacing', 'line-height', 'gap',
  'border-width', 'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'border', 'border-top', 'border-right', 'border-bottom', 'border-left', 'outline',
  'height', 'width', 'min-height', 'max-height', 'min-width', 'max-width',
]);

// Explicit, reasoned exemptions. Each entry names exactly what it lets
// through and why; nothing here is a property- or pattern-wide hole.
const ALLOWLIST = [
  {
    reason: 'glyph/icon raster asset paths (16 rules) are an asset family under the '
      + 'token spec, not a themeable visual-design value; a theme cannot swap icons today.',
    match: (d) => d.property === 'background-image' && /^url\(/i.test(d.value),
  },
  {
    reason: 'chart tooltip opacity starts at 0 and is driven to visible by JS on hover; '
      + 'that is a runtime state, not a design decision a theme would want to change.',
    match: (d) => d.file === 'xchain-charts.css' && d.selector === '.xc-chart-tooltip'
      && d.property === 'opacity' && d.value === '0',
  },
];

function isAllowlisted(d) {
  return ALLOWLIST.some((rule) => rule.match(d));
}

// One declaration can only be reported once; color takes priority since a
// stray hex/rgb/named color is always wrong regardless of which property
// carries it, then radius, then shadow, then the generic spacing family.
function classifyViolation(d) {
  if (isAllowlisted(d)) return null;

  let sawColor = false;
  let sawNumeric = false;
  for (const token of tokenizeValue(d.value)) {
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
  // width/height literal 100% is full-bleed layout, not a size a theme
  // would ever want to change (the spec's own structural exemption); any
  // other numeric width/height is a real design dimension and still flags.
  if (SPACING_PROPS.has(d.property)) {
    if (['width', 'height', 'min-width', 'max-width', 'min-height', 'max-height'].includes(d.property)
      && d.value.trim() === '100%') return null;
    return 'spacing';
  }
  return null;
}

function referencedXcVars(rawCss) {
  const out = new Set();
  for (const m of stripComments(rawCss).matchAll(/var\(\s*(--xc-[\w-]+)/g)) out.add(m[1]);
  return out;
}

describe('theme token-literal gate (M1 A3)', () => {
  const sheets = CSS_FILES.map((name) => ({
    name,
    raw: fs.readFileSync(path.join(CSS_DIR, name), 'utf8'),
  }));

  it('reads no color/radius/shadow/spacing literal outside tokens.css', () => {
    const violations = [];
    for (const sheet of sheets) {
      for (const d of parseDeclarations(sheet.raw, sheet.name)) {
        const category = classifyViolation(d);
        if (category) {
          violations.push(`${d.file}:${d.line} [${d.selector}] ${category} literal - `
            + `${d.property}: ${d.value}`);
        }
      }
    }
    assert.deepEqual(violations, [], `tokenize these before merging:\n${violations.join('\n')}`);
  });

  it('every var(--xc-*) the two stylesheets reference is defined in tokens.css', () => {
    const tokensRaw = fs.readFileSync(TOKENS_FILE, 'utf8');
    const defined = new Set();
    for (const m of stripComments(tokensRaw).matchAll(/(--xc-[\w-]+)\s*:/g)) defined.add(m[1]);

    const missing = [];
    for (const sheet of sheets) {
      for (const name of referencedXcVars(sheet.raw)) {
        if (!defined.has(name)) missing.push(`${sheet.name} references ${name}, undefined in tokens.css`);
      }
    }
    assert.deepEqual(missing, [], missing.join('\n'));
  });
});
