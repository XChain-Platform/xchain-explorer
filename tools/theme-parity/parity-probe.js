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
 *   rule  - for every rule in xchain.css / xchain-charts.css, read back each
 *           property that rule DECLARES, as the computed value on the first
 *           element matching its selector. This proves the stylesheet's own
 *           contribution is unchanged. It is deliberately derived from the
 *           stylesheet at runtime rather than from a hand-written list, so it
 *           cannot fall behind the CSS.
 *
 *           On the pre-tokenization tree this layer is MODE-INDEPENDENT: the
 *           light and dark hashes are identical on every page, because
 *           xchain.css declares no value that resolves differently per mode.
 *           That is a fact about the current CSS, not a bug in the probe, and
 *           it is precisely what acceptance test A4 re-checks afterwards: if
 *           tokenization is done correctly the two modes should still agree
 *           here, with the difference living in the render layer below.
 *
 *   rend  - a fixed census of 31 anchor selectors x 23 properties, read as
 *           computed values no matter which stylesheet won. This proves the
 *           RENDERED result is unchanged, and unlike the rule layer it DOES
 *           differ between light and dark, so it is the layer that can
 *           actually catch a dark-mode regression.
 *
 * LAYOUT-DERIVED KEYS are the exception in both layers, and the reason is a
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
 *     itself. The switch happens on body now, and the probe reads the rendered
 *     mode back off body: two identical readings are rejected, not recorded.
 *
 *   - It fingerprinted whatever it found, including nothing. A page where no
 *     href matched SHEET, or where the sheet was unreadable, or where no
 *     selector matched an element, still returned stable hashes over an empty
 *     snapshot and 31 absence markers.
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
 * every hash must reproduce exactly. To see WHAT moved when one does not,
 * diff the stored snapshots in the page:
 *
 *     const a = JSON.parse(localStorage['__xc:before:coin_home|light|rend']);
 *     const b = JSON.parse(localStorage['__xc:after:coin_home|light|rend']);
 *     Object.keys(a).filter(k => a[k] !== b[k]).map(k => [k, a[k], b[k]]);
 *
 * COVERAGE LIMIT, stated because a probe that hides its blind spot is worse
 * than no probe: across the six captured pages only 79 of the 120 selectors in
 * the two page-level stylesheets are exercised (baseline-2026-08-20.json's
 * coverage block is the authority; 121/77/44 was the superseded pre-tokenization
 * survey). A rule no page instantiates cannot be proven at runtime by any
 * amount of capturing, which is why the static token-literal gate is a
 * separate acceptance test.
 *
 * SHEET now also admits the per-component component.css layer, which landed
 * after the 2026-08-20 capture. That raises the reported cssRules count per
 * page by the component sheets' own rule count and leaves the rule-layer hashes
 * alone, since those component rules match no element on a healthy page.
 *
 **********************************************************************/

window.__XC = (function () {
  const A = ['body','.footer','.footer a','.card','.card-header','.card-body','.navbar','.dropdown-menu',
    'table.dataTable','table.dataTable thead th','table.dataTable tbody td','table.dataTable tbody tr',
    '.btn','.btn-primary','a','h1','h2','.badge','.form-control','.form-select','input','select',
    '#market-info','.market-header','.table-stats th','.table-market-stats th','.dataTables_wrapper',
    '.dataTables_wrapper .dataTables_paginate .paginate_button','.bg-green td','.bg-red td','.pagination'];
  const P = ['color','background-color','background-image','border-top-color','border-bottom-color',
    'border-left-color','border-top-width','border-bottom-width','border-radius','box-shadow','font-family',
    'font-size','font-weight','line-height','letter-spacing','padding-top','padding-left','padding-bottom',
    'margin-top','margin-bottom','opacity','text-decoration-line','text-transform'];
  // Admit every FIRST-PARTY sheet and no vendor one. The component alternative is
  // here because that layer landed later and fell straight through the pattern.
  // Checked against template.html's own link list by theme-token-literal-gate.
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
  // "auto" and a declared width is not renegotiated by layout.
  const LAYOUT = new Set(['width','height','margin-top','margin-right','margin-bottom','margin-left',
    'top','right','bottom','left']);
  const fp = o => { const s = Object.keys(o).sort().map(k => k+'='+o[k]).join('\n');
    let h = 5381; for (let i=0;i<s.length;i++) h = ((h*33)^s.charCodeAt(i))>>>0;
    return { hash: h.toString(16).padStart(8,'0'), keys: Object.keys(o).length }; };
  const ruleSnap = () => {
    const snap = {}; let rules = 0, sheets = 0; const un = [];
    const walk = r => {
      if (r.selectorText && r.style) { rules++;
        const props = Array.from(r.style).filter(p => !p.startsWith('--'));
        if (props.length) for (const raw of r.selectorText.split(',')) {
          const sel = raw.trim(), pe = (sel.match(ELEM)||[])[0]||null, st = STATE.test(sel);
          const base = sel.replace(new RegExp(STATE.source,'g'),'').replace(ELEM,'').trim() || 'body';
          let el; try { el = document.querySelector(base); } catch(e) { un.push(sel+' [bad]'); continue; }
          if (!el) { un.push(sel); continue; }
          const cs = getComputedStyle(el, pe);
          // A state rule (:hover, :visited) cannot be matched without driving the
          // interaction, so resolve its DECLARED value through the element's own
          // custom properties instead. That survives tokenization, where the
          // declared text changes by design and a text comparison would false-alarm.
          // Layout-derived properties take the same declared-value path: their
          // computed readback is the used value, which drifts with content.
          for (const p of props) snap[sel+' | '+p] = (st || LAYOUT.has(p))
            ? r.style.getPropertyValue(p).trim().replace(/var\(\s*(--[\w-]+)\s*(?:,([^)]*))?\)/g,
                (m,n,fb) => cs.getPropertyValue(n).trim() || (fb||'').trim())
            : cs.getPropertyValue(p).trim();
        } }
      if (r.cssRules && r.cssRules.length) for (const c of r.cssRules) walk(c);
    };
    for (const sh of document.styleSheets) { if (!sh.href || !SHEET.test(sh.href)) continue;
      sheets++;
      let rs; try { rs = sh.cssRules; } catch(e) { snap['__UNREADABLE__ '+sh.href] = String(e); continue; }
      for (const r of rs) walk(r); }
    return { rules, snap, un: un.sort(), sheets };
  };
  const rendSnap = () => { const o = {}; let n = 0;
    for (const sel of A) { let el; try { el = document.querySelector(sel); } catch(e) {}
      if (!el) { o[sel+' | __absent'] = '1'; continue; }
      n++; const cs = getComputedStyle(el);
      const cm = el.computedStyleMap && el.computedStyleMap();
      for (const p of P) o[sel+' | '+p] = (LAYOUT.has(p) && cm)
        ? String(cm.get(p)).trim() : cs.getPropertyValue(p).trim(); }
    return { o, n, total: A.length }; };
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
    if (!D.n) bad.push(mode+': the render census matched none of its '+D.total+' anchors');
    return bad;
  };
  // The mode a capture actually rendered in, read off the element the census
  // reads. Two identical witnesses mean the requested mode never took, whatever
  // the probe wrote where.
  const witness = () => { const cs = getComputedStyle(document.body);
    return ['background-color','color','border-top-color']
      .map(p => cs.getPropertyValue(p).trim()).join(' | '); };
  return function capture(tag, phase) {
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
    const res = {}, held = {}, saw = {}, invalid = [];
    try {
      for (const mode of ['light','dark']) {
        document.body.setAttribute('data-bs-theme', mode);
        const R = ruleSnap(), D = rendSnap();
        saw[mode] = witness();
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
    if (saw.light === saw.dark)
      invalid.push('the theme switch did not take: body rendered identically in both modes ('+saw.light+')');
    // Persist nothing from a rejected capture: a degenerate "after" must not be
    // able to overwrite a good stored "before".
    if (invalid.length) { console.error('[theme-parity] capture rejected:\n  '+invalid.join('\n  '));
      return { invalid }; }
    for (const mode of ['light','dark']) {
      localStorage['__xc:'+phase+':'+tag+'|'+mode+'|rule'] = JSON.stringify(held[mode].snap);
      localStorage['__xc:'+phase+':'+tag+'|'+mode+'|rend'] = JSON.stringify(held[mode+'|rend']);
    }
    localStorage['__xcUn:'+phase+':'+tag] = JSON.stringify(held.light.un);
    return res;
  };
})();
