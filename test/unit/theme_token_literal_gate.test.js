const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripComments } = require('./theme_token_literal_gate.test/helpers.js');

// Static companion to tools/theme-parity/parity-probe.js. That probe diffs
// computed styles on live pages, but only 79 of the 120 selectors in these
// two stylesheets are ever instantiated by a page it can capture; the other
// 41 render on no path it drives (baseline-2026-08-20.json's coverage block is
// the authority; 121/77/44 was the superseded pre-tokenization survey). This
// gate covers all 120, plus the component sheets, by reading the stylesheet
// text instead of a rendered page, so it catches a reintroduced literal on a
// selector the probe never sees. The two are complementary, not redundant: the
// probe proves a token swap actually repaints pixels, this gate proves nothing
// was left behind for it to miss.
const CSS_DIR = path.join(__dirname, '..', '..', 'src', 'content', 'css');
const THEME_DIR = path.join(__dirname, '..', '..', 'src', 'content', 'themes');
const TOKENS_FILE = path.join(THEME_DIR, 'classic', 'tokens.css');
const CSS_FILES = ['xchain.css', 'xchain-charts.css'];
// Component stylesheets are held to the same rule as the page-level sheets, and
// for a sharper reason: a component is the unit a theme replaces, so a literal
// baked into one is a value a theme cannot reach even in principle.
const COMPONENT_DIR = path.join(__dirname, '..', '..', 'src', 'content', 'components');
// The probe itself, addressed as data. Nothing else in the repo parses this
// file: the explorer's CSP forbids eval, so it is pasted into a devtools
// console by hand, and a syntax error or a renamed global would surface only
// mid-investigation on a live venue.
const PROBE_FILE = path.join(__dirname, '..', '..', 'tools/theme-parity/parity-probe.js');

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

// Functions whose insides are deliberately NOT classified. var() holds a
// fallback that is a degradation path rather than a stray literal, url() holds
// an asset path, and the rgb/hsl family is already reported whole by
// FUNC_COLOR_RE, so recursing into it would only re-report the same value.
const OPAQUE_FUNC_RE = /^(?:var|url|rgba?|hsla?)\(/i;
// A token that is a single function call, captured as name + argument list.
const CALL_RE = /^([a-zA-Z][\w-]*)\((.*)\)$/s;

// tokenizeValue() splits only at paren depth 0, so a whole function expression
// arrives as ONE token and matches none of the color/numeric patterns:
// `calc(12px + 1rem)` and `linear-gradient(red, blue)` read as clean. Expand
// each transparent function token into its arguments as well, recursively, so
// the classifier sees the literals inside it. Depth is bounded because the
// input is stylesheet text, not a trusted grammar.
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

// One declaration can only be reported once; color takes priority since a
// stray hex/rgb/named color is always wrong regardless of which property
// carries it, then radius, then shadow, then the generic spacing family.
function classifyViolation(d) {
  if (isAllowlisted(d)) return null;

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

function componentSheets() {
  return fs.readdirSync(COMPONENT_DIR)
    .filter((d) => fs.statSync(path.join(COMPONENT_DIR, d)).isDirectory())
    .map((d) => ({ name: d + '/component.css', file: path.join(COMPONENT_DIR, d, 'component.css') }))
    .filter((c) => fs.existsSync(c.file))
    .map((c) => ({ name: c.name, raw: fs.readFileSync(c.file, 'utf8') }));
}

describe('theme token-literal gate (M1 A3)', () => {
  const sheets = CSS_FILES.map((name) => ({
    name,
    raw: fs.readFileSync(path.join(CSS_DIR, name), 'utf8'),
  })).concat(componentSheets());

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

/*
 * Classifier fixtures. The whole-sheet check above can only go red on a literal
 * some first-party sheet actually carries, and none of them carries a function
 * expression at all today, so it stays green whether or not the classifier can
 * see inside one. These drive classifyViolation() directly, which is the only
 * run that can say no to the function-wrapped bypass.
 */
describe('token-literal classifier (function-wrapped values)', () => {
  const decl = (property, value, extra = {}) => ({
    file: 'xchain.css', selector: '.xc-fixture', property, value, line: 1, ...extra,
  });

  it('sees a spacing literal wrapped in calc()', () => {
    assert.equal(classifyViolation(decl('padding', 'calc(12px + 1rem)')), 'spacing');
  });

  it('sees a color literal wrapped in a gradient', () => {
    assert.equal(classifyViolation(decl('background', 'linear-gradient(red, blue)')), 'color');
  });

  it('sees a color literal nested two functions deep', () => {
    assert.equal(
      classifyViolation(decl('background', 'linear-gradient(to right, rgba(0, 0, 0, .2), #fff)')),
      'color');
  });

  it('sees a spacing literal wrapped in clamp()', () => {
    assert.equal(classifyViolation(decl('width', 'clamp(120px, 50%, 480px)')), 'spacing');
  });

  it('still reads a var() fallback as a legitimate degradation path', () => {
    assert.equal(classifyViolation(decl('color', 'var(--xc-body-color, #212529)')), null);
  });

  it('still honours the url() asset allowlist', () => {
    assert.equal(classifyViolation(decl('background-image', 'url(/img/glyph-16.png)')), null);
  });

  it('still honours the chart-tooltip opacity allowlist', () => {
    assert.equal(classifyViolation({
      file: 'xchain-charts.css', selector: '.xc-chart-tooltip',
      property: 'opacity', value: '0', line: 1,
    }), null);
  });

  it('still exempts a bare 100% full-bleed width', () => {
    assert.equal(classifyViolation(decl('width', '100%')), null);
  });
});

describe('theme parity probe (static contract)', () => {
  const probe = fs.readFileSync(PROBE_FILE, 'utf8');

  it('parses as JavaScript', () => {
    // Compile only. new vm.Script never runs the body, so the window and
    // document the probe needs are not required here; what is being proven is
    // that the one file no runner ever loads is still syntactically valid.
    assert.doesNotThrow(
      () => new vm.Script(probe, { filename: PROBE_FILE }),
      'parity-probe.js no longer parses; a paste into the console would fail',
    );
  });

  it('still exposes the __XC global the run instructions paste against', () => {
    assert.match(probe, /window\.__XC\s*=/,
      'tools/theme-parity/README.md documents __XC(tag, phase); the probe must define it');
  });

  it('still recognizes both stylesheets this gate scans', () => {
    // The probe derives its rule layer from the sheets its SHEET pattern
    // admits, so a stylesheet renamed out of that pattern makes the probe
    // report a clean parity run over nothing at all.
    const m = probe.match(/const\s+SHEET\s*=\s*(\/(?:[^/\\\n]|\\.)+\/[a-z]*)/);
    assert.ok(m, 'the probe no longer declares a SHEET pattern in the expected form');
    const sheetRe = new RegExp(m[1].slice(1, m[1].lastIndexOf('/')));
    const unseen = CSS_FILES.filter((name) => !sheetRe.test(`/content/css/${name}`));
    assert.deepEqual(unseen, [],
      `the probe's SHEET pattern skips: ${unseen.join(', ')}`);
  });

  it('admits every first-party stylesheet the page template links', () => {
    // Pin the hand-written SHEET allowlist to the template's own link list, which
    // moves without it (the component sheets landed 2026-09-02 and fell through).
    // Anything linked and not on the vendor list must be admitted, so the next
    // first-party sheet fails here instead of skipping the rule layer in silence.
    const VENDOR = /bootstrap|dataTables|swagger-ui|highlight-|fontawesome/;
    const template = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'content', 'html', 'template.html'), 'utf8');
    const hrefs = [...template.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)]
      .map((m) => m[1]);
    assert.ok(hrefs.length >= 10, `only ${hrefs.length} stylesheet links parsed out of template.html`);
    const firstParty = hrefs.filter((h) => !VENDOR.test(h));
    assert.ok(firstParty.length >= 3, 'the vendor filter swallowed the first-party sheets');

    const m = probe.match(/const\s+SHEET\s*=\s*(\/(?:[^/\\\n]|\\.)+\/[a-z]*)/);
    assert.ok(m, 'the probe no longer declares a SHEET pattern in the expected form');
    const sheetRe = new RegExp(m[1].slice(1, m[1].lastIndexOf('/')));
    const skipped = firstParty.filter((h) => !sheetRe.test(h));
    assert.deepEqual(skipped, [],
      `template.html links these first-party sheets and the probe reads none of them:\n${skipped.join('\n')}`);
  });

});

require('./theme_token_literal_gate.test/bootstrap_surface_bridge.js');
