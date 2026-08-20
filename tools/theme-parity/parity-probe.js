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
 * under __xc:<phase>:<tag>|<mode>|<layer>, and returns only fingerprints.
 * Compare the returned hashes against tools/theme-parity/baseline-<date>.json;
 * every hash must reproduce exactly. To see WHAT moved when one does not,
 * diff the stored snapshots in the page:
 *
 *     const a = JSON.parse(localStorage['__xc:before:coin_home|light|rend']);
 *     const b = JSON.parse(localStorage['__xc:after:coin_home|light|rend']);
 *     Object.keys(a).filter(k => a[k] !== b[k]).map(k => [k, a[k], b[k]]);
 *
 * COVERAGE LIMIT, stated because a probe that hides its blind spot is worse
 * than no probe: across the six captured pages only 77 of the 121 selectors in
 * the two stylesheets are exercised. A rule no page instantiates cannot be
 * proven at runtime by any amount of capturing, which is why the static
 * static token-literal gate is a separate acceptance test.
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
  const SHEET = /\/(xchain|xchain-charts)\.css|\/themes\//;
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
    const snap = {}; let rules = 0; const un = [];
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
      let rs; try { rs = sh.cssRules; } catch(e) { snap['__UNREADABLE__ '+sh.href] = String(e); continue; }
      for (const r of rs) walk(r); }
    return { rules, snap, un: un.sort() };
  };
  const rendSnap = () => { const o = {}; let n = 0;
    for (const sel of A) { let el; try { el = document.querySelector(sel); } catch(e) {}
      if (!el) { o[sel+' | __absent'] = '1'; continue; }
      n++; const cs = getComputedStyle(el);
      const cm = el.computedStyleMap && el.computedStyleMap();
      for (const p of P) o[sel+' | '+p] = (LAYOUT.has(p) && cm)
        ? String(cm.get(p)).trim() : cs.getPropertyValue(p).trim(); }
    return { o, n, total: A.length }; };
  return function capture(tag, phase) {
    const orig = document.documentElement.getAttribute('data-bs-theme'); const res = {};
    for (const mode of ['light','dark']) {
      document.documentElement.setAttribute('data-bs-theme', mode);
      const R = ruleSnap(), D = rendSnap();
      localStorage['__xc:'+phase+':'+tag+'|'+mode+'|rule'] = JSON.stringify(R.snap);
      localStorage['__xc:'+phase+':'+tag+'|'+mode+'|rend'] = JSON.stringify(D.o);
      res[mode] = { rule: fp(R.snap), rend: fp(D.o), anchors: D.n+'/'+D.total, cssRules: R.rules };
      if (mode === 'light') localStorage['__xcUn:'+phase+':'+tag] = JSON.stringify(R.un);
    }
    document.documentElement.setAttribute('data-bs-theme', orig || 'light');
    return res;
  };
})();
