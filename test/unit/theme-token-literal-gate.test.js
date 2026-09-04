const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

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
const SKIN_FILE = path.join(THEME_DIR, 'skin-demo', 'tokens.css');
const CSS_FILES = ['xchain.css', 'xchain-charts.css'];
// Component stylesheets are held to the same rule as the page-level sheets, and
// for a sharper reason: a component is the unit a theme replaces, so a literal
// baked into one is a value a theme cannot reach even in principle.
const COMPONENT_DIR = path.join(__dirname, '..', '..', 'src', 'content', 'components');
const BOOTSTRAP_FILE = path.join(CSS_DIR, 'bootstrap.min.css');
// The probe itself, addressed as data. Nothing else in the repo parses this
// file: the explorer's CSP forbids eval, so it is pasted into a devtools
// console by hand, and a syntax error or a renamed global would surface only
// mid-investigation on a live venue.
const PROBE_FILE = path.join(__dirname, '..', '..', 'tools/theme-parity/parity-probe.js');

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

function componentSheets() {
  return fs.readdirSync(COMPONENT_DIR)
    .filter((d) => fs.statSync(path.join(COMPONENT_DIR, d)).isDirectory())
    .map((d) => ({ name: d + '/component.css', file: path.join(COMPONENT_DIR, d, 'component.css') }))
    .filter((c) => fs.existsSync(c.file))
    .map((c) => ({ name: c.name, raw: fs.readFileSync(c.file, 'utf8') }));
}

// The custom properties one selector block declares, as name -> value.
// Whitespace between the selector parts and the brace is normalised, because
// the shipped files are hand-formatted and the vendored Bootstrap build is
// minified; matching the literal text would make this helper agree with one and
// silently return null for the other.
function declarationsIn(css, selector) {
  const stripped = stripComments(css);
  const pattern = selector.trim().split(/\s+/).map((part) =>
    part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*');
  // Anchored on a preceding block/statement boundary so a selector cannot be
  // matched as the tail of a longer one (":root" inside ":not(:root)").
  const re = new RegExp('(?:^|[};])\\s*' + pattern + '\\s*\\{([^{}]*)\\}');
  const m = re.exec(stripped);
  if (!m) return null;
  const out = {};
  for (const decl of m[1].split(';')) {
    const colon = decl.indexOf(':');
    if (colon === -1) continue;
    out[decl.slice(0, colon).trim()] = decl.slice(colon + 1).trim();
  }
  return out;
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

/*
 * Row 22a: the token layer extended over Bootstrap's own surface variables.
 *
 * Before this, a skin could move exactly the values xchain.css and
 * xchain-charts.css declared - footer, table borders, status tints, chart
 * chrome - and the page UNDER that chrome stayed Bootstrap-default, because
 * background, body text, links and borders come from --bs-* variables no
 * tokens.css could reach. The bridge re-points those at --xc-surface-* tokens.
 *
 * The bridge is only safe if classic's values are Bootstrap's values, so the
 * first test reads them back out of the vendored bootstrap.min.css rather than
 * restating them: a transcription slip here would repaint every page in the
 * explorer, and a hand-copied expectation would agree with the slip.
 *
 * The second test is the one that would otherwise be found by eye, weeks later,
 * in dark mode only. updateTheme() writes data-bs-theme onto BODY, so Bootstrap
 * redeclares its --bs-* surface variables ON body for both modes; a bridge
 * declared only on :root is inherited by body and immediately overridden there.
 * It has to be declared on the same elements Bootstrap uses.
 */
describe('Bootstrap surface bridge (row 22a)', () => {

  const classic   = fs.readFileSync(TOKENS_FILE, 'utf8');
  const skin      = fs.readFileSync(SKIN_FILE, 'utf8');
  const bootstrap = fs.readFileSync(BOOTSTRAP_FILE, 'utf8');

  const bridgeSelector = ':root,\n[data-bs-theme="light"],\n[data-bs-theme="dark"]';

  function bridged() {
    const decls = declarationsIn(classic, bridgeSelector);
    assert.ok(decls, 'the --bs-* bridge block was not found in classic/tokens.css');
    return decls;
  }

  it('points every bridged --bs-* variable at an --xc-surface-* token', () => {
    const decls = bridged();
    const names = Object.keys(decls).filter((k) => k.startsWith('--bs-'));
    assert.ok(names.length >= 20, `only ${names.length} Bootstrap variables are bridged`);
    const direct = names.filter((n) => !/^var\(--xc-surface-[\w-]+\)$/.test(decls[n]));
    assert.deepEqual(direct, [],
      'bridged variables set to a literal rather than to a token; a skin cannot move these:\n'
      + direct.map((n) => `${n}: ${decls[n]}`).join('\n'));
  });

  it('gives classic exactly Bootstrap\'s own values, so the page renders unchanged', () => {
    const bsLight = declarationsIn(bootstrap, ':root,[data-bs-theme=light]');
    const bsDark  = declarationsIn(bootstrap, '[data-bs-theme=dark]');
    assert.ok(bsLight && bsDark, 'could not read Bootstrap\'s own surface defaults');

    const xcLight = declarationsIn(classic, ':root');
    const xcDark  = declarationsIn(classic, '[data-bs-theme="dark"]');

    const wrong = [];
    for (const bsName of Object.keys(bridged())) {
      if (!bsName.startsWith('--bs-')) continue;
      const token = '--xc-surface-' + bsName.slice('--bs-'.length);
      for (const [mode, xc, bs] of [['light', xcLight, bsLight], ['dark', xcDark, bsDark]]) {
        if (xc[token] === undefined) { wrong.push(`${token} is undefined in the ${mode} block`); continue; }
        if (xc[token] !== bs[bsName]) wrong.push(`${mode}: ${token} is ${xc[token]}, Bootstrap ships ${bs[bsName]}`);
      }
    }
    assert.deepEqual(wrong, [],
      'classic would repaint the page rather than reproduce it:\n  ' + wrong.join('\n  '));
  });

  it('declares the bridge on every selector that can carry the mode', () => {
    // A bridge on :root alone works in light and silently fails in dark, because
    // body carries the theme attribute and Bootstrap redeclares there.
    assert.ok(classic.includes(bridgeSelector),
      'the bridge is not declared on :root, [data-bs-theme="light"] and [data-bs-theme="dark"] together');
  });

  it('reaches the surface a skin most needs: background, text, links and borders', () => {
    const decls = bridged();
    for (const name of ['--bs-body-bg', '--bs-body-color', '--bs-link-color', '--bs-border-color'])
      assert.ok(decls[name], `${name} is not bridged, so a skin cannot move it`);
  });

  it('carries the -rgb triples, without which every translucent overlay stays behind', () => {
    // Bootstrap composes overlays as rgba(var(--bs-body-bg-rgb), .5). A skin that
    // moved only the hex would leave those on the old palette - a half-recoloured
    // page, which is worse than one that did not move at all.
    const decls = bridged();
    for (const name of ['--bs-body-bg-rgb', '--bs-body-color-rgb', '--bs-link-color-rgb',
                        '--bs-secondary-bg-rgb', '--bs-tertiary-bg-rgb'])
      assert.ok(decls[name], `${name} is not bridged`);
  });

  it('gives the demo skin the same token names as classic, so it is a drop-in', () => {
    const names = (css) => new Set([...stripComments(css).matchAll(/(--xc-[\w-]+)\s*:/g)].map((m) => m[1]));
    const c = names(classic);
    const s = names(skin);
    const missing = [...c].filter((n) => !s.has(n));
    const extra   = [...s].filter((n) => !c.has(n));
    // An omitted token falls back to nothing and invalidates its declaration, so
    // a partial skin breaks a rule rather than restyling it.
    assert.deepEqual(missing, [], 'tokens classic defines that the skin does not: ' + missing.join(', '));
    assert.deepEqual(extra, [], 'tokens the skin defines that classic does not: ' + extra.join(', '));
  });

  it('actually MOVES the surface in the demo skin, which is what row 22a was for', () => {
    const cLight = declarationsIn(classic, ':root');
    const sLight = declarationsIn(skin, ':root');
    const surface = Object.keys(cLight).filter((n) => n.startsWith('--xc-surface-'));
    const moved = surface.filter((n) => sLight[n] !== cLight[n]);
    assert.ok(moved.length >= 15,
      `the skin moves only ${moved.length} of ${surface.length} surface tokens; loading it would `
      + 'still leave the page on Bootstrap\'s palette, which is the finding row 22a recorded');
  });

  it('does not restate the bridge in the skin: a skin overrides values, not wiring', () => {
    assert.equal(declarationsIn(skin, bridgeSelector), null,
      'the skin redeclares the --bs-* bridge; two copies of the wiring will drift');
  });
});
