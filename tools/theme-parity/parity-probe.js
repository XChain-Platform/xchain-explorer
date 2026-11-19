/**********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * THEME PARITY PROBE - evidence for the token milestone of the explorer
 * theme and layout system.
 *
 * WHY THIS EXISTS. Moving every hardcoded visual decision out of xchain.css
 * into --xc-* custom properties is supposed to change nothing a user can see.
 * "Supposed to" is not evidence, and a screenshot comparison cannot supply it
 * on a live venue: the chain advances under the capture, so pixels differ for
 * reasons that have nothing to do with CSS. This probe compares what the
 * BROWSER COMPUTED instead, which is data-independent.
 *
 * TWO LAYERS, because either one alone lies:
 *
 *   rule  - for every rule in the sheets SHEET admits (xchain.css,
 *           xchain-charts.css, themes/, components/<name>/component.css), read back each
 *           property that rule DECLARES, as the computed value on the first
 *           element matching its selector. This proves the stylesheet's own
 *           contribution is unchanged. It is deliberately derived from the
 *           stylesheet at runtime rather than from a hand-written list, so it
 *           cannot fall behind the CSS.
 *
 *           Because it reads computed values, this layer follows mode wherever
 *           a declared value resolves through a mode-following token (a theme
 *           dark-block token or a Bootstrap --bs-* variable) on an element the
 *           page renders: .xc-chart-nodata (an empty chart), .xc-stat-tile
 *           (mounted on every coin_home load) and .xc-badge differ by mode, so
 *           the two modes agree here only on pages rendering none of those.
 *           See README.md, "What the two layers mean". The render layer below
 *           is still where a dark-mode regression shows.
 *
 *   rend  - a fixed census of 31 anchor selectors x 29 properties, read as
 *           computed values no matter which stylesheet won. This proves the
 *           RENDERED result is unchanged, and unlike the rule layer it DOES
 *           differ between light and dark, so it is the layer that can
 *           actually catch a dark-mode regression.
 *
 * LAYOUT-DERIVED KEYS (widths, heights, margins, offsets and the grid track
 * templates) are the exception in both layers, and the reason is a
 * class of false movement this probe once emitted: getComputedStyle returns
 * the USED value for widths, heights, margins and offsets, which layout
 * renegotiates against page content - an auto margin comes back as slack
 * pixels, a declared 75px table column comes back redistributed by fractions
 * of a pixel. On a live chain those values move between captures with no CSS
 * change at all. The keys STAY in the census (deleting them would blind the
 * probe to real CSS changes on those properties); their VALUES are read
 * layout-independently instead - see the LAYOUT set below.
 *
 * A CAPTURE VOUCHES FOR ITSELF, because a fingerprint of nothing is stable and
 * therefore indistinguishable from a fingerprint of a healthy page. Two ways
 * this probe has produced a clean-looking proof of nothing:
 *
 *   - It flipped data-bs-theme on documentElement while updateTheme() writes it
 *     on BODY, and tokens.css declares the --xc-* surface tokens on whichever
 *     element carries the attribute. On a page initialised in dark, body kept
 *     its own dark declaration through both iterations, so the capture labelled
 *     light measured dark surfaces and the render layer compared a mode against
 *     itself. The switch happens on body now, and a Bootstrap custom property
 *     declared on that same element proves that each requested mode took.
 *
 *   - It fingerprinted whatever it found, including nothing. A page where no
 *     href matched SHEET, or where the sheet was unreadable, or where no
 *     selector matched an element, still returned stable hashes over an empty
 *     snapshot and 31 absence markers.
 *
 * A browser with no CSS Typed OM (Element.prototype.computedStyleMap) is refused
 * too: the render census would read its layout-derived keys as used values.
 *
 * A capture that fails any of those checks returns { invalid: [reasons] } with
 * no hashes and writes NOTHING to localStorage, so a degenerate run can neither
 * be mistaken for evidence nor overwrite a good stored snapshot.
 *
 * A note on the one non-obvious implementation detail: Chrome gives EVERY
 * CSSStyleRule an empty `.cssRules` list (CSS nesting), so a naive
 * `if (rule.cssRules) recurse` treats every plain rule as a group, walks its
 * zero children, and silently captures NOTHING. The first cut of this probe
 * did exactly that and reported a clean 0-key "parity proof". Recursion is
 * therefore guarded on `.cssRules.length`.
 *
 * HOW TO RUN. The explorer's CSP allows inline scripts but not eval, so paste
 * this whole file into the devtools console on the page under test (or append
 * it as a <script> element). Then:
 *
 *     __XC('<page-tag>', 'before')   // pre-change baseline
 *     __XC('<page-tag>', 'after')    // post-change, same tag
 *
 * Each call snapshots BOTH modes, stores the full snapshots in localStorage
 * under __xc:<phase>:<tag>|<mode>|<layer>, and returns fingerprints plus the
 * mode each capture actually rendered in.
 * Compare the returned hashes against tools/theme-parity/baseline-<date>.json;
 * every hash must reproduce exactly. baseline-2026-08-20.json predates the
 * body-side mode switch above (2026-09-05), so its per-mode rend hashes are not
 * light/dark evidence: capture a fresh baseline with this probe before comparing
 * modes (README, "Mode-switch correction"). To see WHAT moved when a hash does
 * not reproduce, diff the stored snapshots in the page:
 *
 *     const a = JSON.parse(localStorage['__xc:before:coin_home|light|rend']);
 *     const b = JSON.parse(localStorage['__xc:after:coin_home|light|rend']);
 *     Object.keys(a).filter(k => a[k] !== b[k]).map(k => [k, a[k], b[k]]);
 *
 * COVERAGE LIMIT, stated because a probe that hides its blind spot is worse
 * than no probe: the probe records per-sheet selector coverage and unions
 * matches across both modes, but a rule no captured page instantiates still
 * cannot be proven at runtime. The static token-literal gate remains a separate
 * acceptance test for that reason. The 2026-08-20 baseline measured 79 of 120
 * page-level selectors; later dated baselines predate this coverage export.
 *
 * SHEET now also admits the per-component component.css layer, which landed
 * after the 2026-08-20 capture. That raises the reported cssRules count per
 * page by the component sheets' own rule count, and it moves the rule-layer
 * hash of any page that mounts a component (coin_home has since 2026-09-26).
 *
 **********************************************************************/

(function (exporting) {
const probe = (function () {
  const A = ['body','.footer','.footer a','.card','.card-header','.card-body','.navbar','.dropdown-menu',
    'table.dataTable','table.dataTable thead th','table.dataTable tbody td','table.dataTable tbody tr',
    '.btn','.btn-primary','a','h1','h2','.badge','.form-control','.form-select','input','select',
    '#market-info','.market-header','.table-stats th','.table-market-stats th','.dataTables_wrapper',
    '.dataTables_wrapper .dataTables_paginate .paginate_button','.bg-green td','.bg-red td','.pagination'];
  // Every box property on all four sides: the table-cell anchor declares padding-right
  // and its first and last cells set border-left-width and border-right-width.
  const P = ['color','background-color','background-image','border-top-color','border-bottom-color',
    'border-left-color','border-right-color','border-top-width','border-bottom-width','border-left-width',
    'border-right-width','border-radius','box-shadow','font-family','font-size','font-weight','line-height',
    'letter-spacing','padding-top','padding-right','padding-left','padding-bottom','margin-top','margin-right',
    'margin-bottom','margin-left','opacity','text-decoration-line','text-transform'];
  // Admit every FIRST-PARTY sheet and no vendor one. The component alternative is
  // here because that layer landed later and fell straight through the pattern.
  // Checked by theme-token-literal-gate against template.html's own link list and
  // against every themes/*/tokens.css @import target; walk() follows those imports,
  // which document.styleSheets never lists.
  const SHEET = /\/(xchain|xchain-charts)\.css|\/themes\/|\/components\/[^\/]+\/component\.css/;
  const STATE = /:{1,2}(hover|visited|active|focus|focus-visible|focus-within|target)\b/;
  const ELEM  = /::(before|after|placeholder|marker|selection|first-line|first-letter)\b/;
  // Properties whose getComputedStyle readback is the USED value, resolved by
  // layout against page content: an auto margin comes back as slack pixels,
  // and table auto-layout redistributes a declared cell width by fractions of
  // a pixel. On a live chain that content moves between captures, so a
  // used-value comparison reports CSS changes that never happened. These keys
  // STAY in both layers but are read as layout-independent values instead:
  // the rule layer resolves the DECLARED text through the element's custom
  // properties (the same mechanism state rules already use), and the render
  // census reads the Typed OM computedStyleMap, where an auto margin is still
  // "auto" and a declared width is not renegotiated by layout. The grid track
  // templates belong here too: on a grid container the computed readback is the
  // used track list in pixels, which follows the viewport and the cell content.
  const LAYOUT = new Set(['width','height','margin-top','margin-right','margin-bottom','margin-left',
    'top','right','bottom','left','grid-template-columns','grid-template-rows']);
  const DECLARED_JOIN = ' || ';
  const fp = o => { const s = Object.keys(o).sort().map(k => k+'='+o[k]).join('\n');
    let h = 5381; for (let i=0;i<s.length;i++) h = ((h*33)^s.charCodeAt(i))>>>0;
    return { hash: h.toString(16).padStart(8,'0'), keys: Object.keys(o).length }; };
  const censusHash = values => fp(values.reduce((o, value) => { o[value] = '1'; return o; }, {})).hash;
  const schema = Object.freeze({ version: 1,
    anchors: Object.freeze({ count: A.length, hash: censusHash(A) }),
    properties: Object.freeze({ count: P.length, hash: censusHash(P) }) });
  // Resolve every var(--name, fallback) in a declared value against an element's custom
  // properties. The closing paren is found by depth, so a fallback such as
  // rgba(0,0,0,.5) or a nested var() stays whole, and an unresolved name takes its
  // resolved fallback. Text that is not a well-formed var() call is left as written.
  const resolveVars = (text, cs) => { let out = '', i = 0;
    while (i < text.length) {
      const at = text.indexOf('var(', i);
      if (at < 0) { out += text.slice(i); break; }
      let depth = 1, j = at + 4, comma = -1;
      for (; j < text.length && depth > 0; j++) { const c = text[j];
        if (c === '(') depth++; else if (c === ')') depth--; else if (c === ',' && depth === 1 && comma < 0) comma = j; }
      const name = text.slice(at + 4, comma < 0 ? j - 1 : comma).trim();
      if (depth > 0 || !/^--[\w-]+$/.test(name)) { out += text.slice(i, at + 4); i = at + 4; continue; }
      const fb = comma < 0 ? '' : resolveVars(text.slice(comma + 1, j - 1), cs).trim();
      out += text.slice(i, at) + (cs.getPropertyValue(name).trim() || fb); i = j; }
    return out; };
  // CSSOM serializes a longhand expanded from a var()-bearing shorthand as an
  // empty string. Recover the owning shorthand text so declared-path hashes can
  // still observe token changes without reading layout-dependent used values.
  const shorthandCandidates = p => { const out = [];
    const border = /^border-(top|right|bottom|left)-(color|style|width)$/.exec(p);
    if (border) out.push('border-'+border[1], 'border-'+border[2], 'border');
    if (/^(top|right|bottom|left)$/.test(p)) out.push('inset');
    if (/^(row|column)-gap$/.test(p)) out.push('gap');
    if (/^grid-template-(columns|rows)$/.test(p)) out.push('grid-template', 'grid');
    const parts = p.split('-'); while (parts.length > 1) { parts.pop(); out.push(parts.join('-')); }
    return Array.from(new Set(out)); };
  const declaredRead = (style, p, cs) => { const raw = style.getPropertyValue(p).trim();
    if (raw) return { value: resolveVars(raw, cs), missing: false };
    for (const shorthand of shorthandCandidates(p)) { const text = style.getPropertyValue(shorthand).trim();
      if (text) return { value: shorthand+': '+resolveVars(text, cs), missing: false }; }
    return { value: '', missing: true }; };
  const joinCondition = (outer, inner) => outer && inner ? outer+' > '+inner : outer || inner;
  const ruleCondition = r => {
    const media = r.media && typeof r.media.mediaText === 'string' ? r.media.mediaText.trim() : '';
    if (media) return '@media '+media;
    const text = typeof r.conditionText === 'string' ? r.conditionText.trim() : '';
    if (!text) return '';
    const css = typeof r.cssText === 'string' ? r.cssText.trim() : '';
    if ('containerName' in r || /^@container\b/.test(css)) {
      const name = typeof r.containerName === 'string' ? r.containerName.trim() : '';
      return '@container '+(name ? name+' ' : '')+text;
    }
    return '@supports '+text;
  };
  const ruleSnap = () => {
    const snap = {}, coverage = {}; let rules = 0, sheets = 0; const un = [], emptyDeclared = []; const seen = new Map();
    const sheetId = href => { try { return new URL(href, location.href).pathname; } catch(e) { return href; } };
    const cover = (href, sel, matched) => { const id = sheetId(href);
      const row = coverage[id] || (coverage[id] = { selectors: new Set(), matched: new Set() });
      row.selectors.add(sel); if (matched) row.matched.add(sel); };
    // Read one admitted sheet once; an unreadable one is recorded so health()
    // rejects the capture rather than fingerprinting a partial rule layer.
    const readSheet = (sh, cond = '') => { if (!sh || !sh.href || !SHEET.test(sh.href)) return;
      const conditions = seen.get(sh) || new Set();
      if (conditions.has(cond)) return;
      if (!seen.has(sh)) { seen.set(sh, conditions); sheets++; }
      conditions.add(cond);
      let rs; try { rs = sh.cssRules; } catch(e) { snap['__UNREADABLE__ '+sh.href] = String(e); return; }
      for (const r of rs) walk(r, sh.href, cond); };
    const walk = (r, baseHref, cond = '') => {
      // An @import rule carries its sheet in .styleSheet, the only way to reach it.
      // Chrome hands a 404 import an EMPTY sheet; a null styleSheet is recorded too.
      if (typeof r.href === 'string' && 'styleSheet' in r) {
        if (r.styleSheet) { const sh = r.styleSheet; readSheet(sh, joinCondition(cond, ruleCondition(r)));
          let n = -1; try { n = sh.cssRules.length; } catch(e) {}
          if (n === 0 && sh.href && SHEET.test(sh.href)) snap['__UNREADABLE__ '+sh.href] = 'import loaded no rules';
          return; }
        let url; try { url = new URL(r.href, baseHref || location.href).href; } catch(e) { url = r.href; }
        if (SHEET.test(url)) snap['__UNREADABLE__ '+url] = 'import did not load';
        return;
      }
      if (r.selectorText && r.style) { rules++;
        const props = Array.from(r.style).filter(p => !p.startsWith('--'));
        if (props.length) for (const raw of r.selectorText.split(',')) {
          const sel = raw.trim(), pe = (sel.match(ELEM)||[])[0]||null, st = STATE.test(sel);
          const baseSel = sel.replace(new RegExp(STATE.source,'g'),'').replace(ELEM,'').trim() || 'body';
          let el; try { el = document.querySelector(baseSel); } catch(e) { cover(baseHref, sel, false); un.push(sel+' [bad]'); continue; }
          cover(baseHref, sel, Boolean(el));
          if (!el) { un.push(sel); continue; }
          const cs = getComputedStyle(el, pe);
          // A state rule (:hover, :visited) cannot be matched without driving the
          // interaction, so resolve its DECLARED value through the element's own
          // custom properties instead. That survives tokenization, where the
          // declared text changes by design and a text comparison would false-alarm.
          // Layout-derived properties take the same declared-value path: their
          // computed readback is the used value, which drifts with content.
          // The enclosing condition is part of every key. The cascade and which
          // condition matches the viewport are not modelled, but editing a
          // condition moves the hash and separates scoped declarations.
          for (const p of props) { const key = (cond ? cond+' :: ' : '')+sel+' | '+p;
            if (st || LAYOUT.has(p)) {
              const declared = declaredRead(r.style, p, cs);
              if (declared.missing) emptyDeclared.push(key);
              snap[key] = key in snap ? snap[key]+DECLARED_JOIN+declared.value : declared.value;
            } else snap[key] = cs.getPropertyValue(p).trim(); }
        } }
      const childCondition = joinCondition(cond, ruleCondition(r));
      if (r.cssRules && r.cssRules.length) for (const c of r.cssRules) walk(c, baseHref, childCondition);
    };
    for (const sh of document.styleSheets) readSheet(sh);
    const covered = {}; for (const id of Object.keys(coverage).sort()) covered[id] = {
      selectors: Array.from(coverage[id].selectors).sort(), matched: Array.from(coverage[id].matched).sort() };
    return { rules, snap, un: un.sort(), sheets, coverage: covered, emptyDeclared };
  };
  // Count every layout key read as a used value because the browser has no Typed OM;
  // health() refuses such a capture, and the count stays out of `o` so hashes do not move.
  const rendSnap = () => { const o = {}; let n = 0, untyped = 0;
    for (const sel of A) { let el; try { el = document.querySelector(sel); } catch(e) {}
      if (!el) { o[sel+' | __absent'] = '1'; continue; }
      n++; const cs = getComputedStyle(el);
      const cm = el.computedStyleMap && el.computedStyleMap();
      for (const p of P) { if (LAYOUT.has(p) && !cm) untyped++;
        o[sel+' | '+p] = (LAYOUT.has(p) && cm)
          ? String(cm.get(p)).trim() : cs.getPropertyValue(p).trim(); } }
    return { o, n, total: A.length, untyped }; };
  // Everything a capture can be wrong ABOUT, asked of the capture itself. A
  // fingerprint of nothing is stable, so an empty snapshot and a healthy one
  // are indistinguishable downstream: a fresh before/after pair taken on a page
  // that matched no sheet and no element agrees over nothing and reads as a
  // parity pass. These are the signals ruleSnap/rendSnap already compute.
  const health = (mode, R, D) => {
    const bad = [];
    if (!R.sheets) bad.push(mode+': no stylesheet matched SHEET, so the rule layer read nothing');
    if (!R.rules) bad.push(mode+': the rule layer walked 0 rules');
    if (!Object.keys(R.snap).length) bad.push(mode+': the rule snapshot is empty');
    for (const k of Object.keys(R.snap)) if (k.indexOf('__UNREADABLE__ ') === 0)
      bad.push(mode+': unreadable stylesheet '+k.slice(15));
    if (R.emptyDeclared.length) bad.push(mode+': declared-path keys read empty with no shorthand text: '
      +R.emptyDeclared.join(', '));
    if (!D.n) bad.push(mode+': the render census matched none of its '+D.total+' anchors');
    // Refuse used-value layout keys: they drift with page content and read as a CSS change.
    if (D.untyped) bad.push(mode+': the render census read '+D.untyped+' layout-derived keys through '
      +'getComputedStyle because this browser has no CSS Typed OM computedStyleMap; use one that has it');
    return bad;
  };
  // Keep the surface reading in the result for baseline comparison. Prove the
  // body-side switch separately with a Bootstrap variable declared in both modes.
  const witness = () => { const cs = getComputedStyle(document.body);
    return ['background-color','color','border-top-color']
      .map(p => cs.getPropertyValue(p).trim()).join(' | '); };
  const modeWitness = () => getComputedStyle(document.body)
    .getPropertyValue('--bs-primary-text-emphasis').trim();
  const capture = function (tag, phase) {
    if (!document.body) return { invalid: ['the page has no body element to capture'] };
    // The application marks the mode on BODY (updateTheme() in
    // src/content/js/xchain.js), and themes/*/tokens.css declares the --xc-*
    // surface tokens on whichever element carries the attribute. Marking
    // documentElement instead therefore changes nothing on a page the app has
    // already marked: body's own declarations override the inherited root
    // values, so a page initialised in dark returned dark surfaces for BOTH
    // captures and the light/dark comparison compared a mode against itself.
    const had = document.body.hasAttribute('data-bs-theme');
    const orig = document.body.getAttribute('data-bs-theme');
    const res = {}, held = {}, saw = {}, modeSaw = {}, invalid = [];
    try {
      for (const mode of ['light','dark']) {
        document.body.setAttribute('data-bs-theme', mode);
        const R = ruleSnap(), D = rendSnap();
        saw[mode] = witness();
        modeSaw[mode] = modeWitness();
        for (const why of health(mode, R, D)) invalid.push(why);
        held[mode] = R;
        held[mode+'|rend'] = D.o;
        res[mode] = { rule: fp(R.snap), rend: fp(D.o), anchors: D.n+'/'+D.total,
          cssRules: R.rules, rendered: saw[mode] };
      }
    } finally {
      // Restore in a finally so a throw inside the loop cannot strand the
      // operator's page in the probe's last mode.
      if (had) document.body.setAttribute('data-bs-theme', orig);
      else document.body.removeAttribute('data-bs-theme');
    }
    if (modeSaw.light === modeSaw.dark)
      invalid.push('the theme switch did not take: body mode witness stayed '+modeSaw.light);
    // Persist nothing from a rejected capture: a degenerate "after" must not be
    // able to overwrite a good stored "before".
    if (invalid.length) { console.error('[theme-parity] capture rejected:\n  '+invalid.join('\n  '));
      return { invalid }; }
    for (const mode of ['light','dark']) {
      localStorage['__xc:'+phase+':'+tag+'|'+mode+'|rule'] = JSON.stringify(held[mode].snap);
      localStorage['__xc:'+phase+':'+tag+'|'+mode+'|rend'] = JSON.stringify(held[mode+'|rend']);
    }
    localStorage['__xcUn:'+phase+':'+tag] = JSON.stringify(held.light.un);
    const coverage = { sheets: {} };
    for (const id of new Set(Object.keys(held.light.coverage).concat(Object.keys(held.dark.coverage)))) {
      const light = held.light.coverage[id] || { selectors: [], matched: [] };
      const dark = held.dark.coverage[id] || { selectors: [], matched: [] };
      coverage.sheets[id] = { selectors: Array.from(new Set(light.selectors.concat(dark.selectors))).sort(),
        matched: Array.from(new Set(light.matched.concat(dark.matched))).sort() };
    }
    res.coverage = coverage;
    res.probe = schema;
    localStorage['__xcResult:'+phase+':'+tag] = JSON.stringify({
      url: location.pathname+location.search, probe: schema, light: res.light, dark: res.dark, coverage,
    });
    return res;
  };
  capture.schema = schema;
  capture.export = phase => {
    const prefix = '__xcResult:'+phase+':', pages = {};
    for (const key of Object.keys(localStorage).sort())
      if (key.indexOf(prefix) === 0) pages[key.slice(prefix.length)] = JSON.parse(localStorage[key]);
    return { phase, probe: schema, pages };
  };
  return capture;
})();
if (typeof window !== 'undefined') window.__XC = probe;
if (exporting) module.exports = probe.schema;
})(typeof module !== 'undefined' && !!module.exports);
