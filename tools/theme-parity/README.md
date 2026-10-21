# Theme parity evidence

Evidence tooling for the M1 *tokens* milestone of
the explorer theme and layout system: the token milestone, its parity
evidence, and the static gate that backs it up.

Moving hardcoded values out of `xchain.css` into `--xc-*` custom properties is
meant to change nothing a user can see. This directory is how that claim is
measured instead of asserted.

## Why not screenshots

The venue is a live regtest chain. Blocks arrive, tables repaint, and a pixel
diff reports all of it as change, so a screenshot comparison cannot separate
"the CSS moved" from "the chain moved". The probe compares what the browser
COMPUTED for each element instead, which no amount of chain activity alters.

Screenshots still have a job, and it is the operator's eye, not the gate: look
at the five master pages after the change and see that they look right.

## Running it

The explorer's CSP allows inline scripts but forbids `eval`, so the probe is
pasted, not loaded from a string.

1. Reach the venue explorer. From this Mac:
   `ssh -N -L 18080:localhost:18080 <regtest-host>`
2. Open a page under test, e.g. `http://localhost:18080/RDOGE`.
3. Paste all of `parity-probe.js` into the devtools console of a browser with
   CSS Typed OM (`Element.prototype.computedStyleMap`); Chrome has it.
4. Capture:
   - before any CSS change: `__XC('coin_home', 'before')`
   - after: `__XC('coin_home', 'after')`
5. Repeat per page, using the tags and URLs recorded in the baseline JSON.

Each call snapshots BOTH light and dark, writes the full snapshots to
localStorage, and returns per-mode fingerprints plus a `rendered` reading of
the surface colours that capture actually measured. Compare the hashes against
a dated baseline built by `capture-baseline.js`, one that carries a `probe`
schema object: every hash must reproduce exactly.
`baseline-2026-08-20.json` predates the 2026-09-05 mode-switch correction, so
its per-mode `rend` hashes are not light/dark evidence; see "Mode-switch
correction (2026-09-05)" below.

A capture can also come back as `{ invalid: [reasons] }` with no hashes at
all. That is not a failed comparison, it is a refusal to mint evidence: the
probe rejects a run where no stylesheet matched `SHEET`, where a sheet was
unreadable, where the rule snapshot came back empty, where the render census
matched no anchor, where the browser had no Typed OM `computedStyleMap` for the
layout-derived keys, or where the two modes rendered identically. A rejected
capture writes nothing to localStorage, so it cannot overwrite a good stored
snapshot, and it must never be compared against a baseline.

Every accepted capture also stores a compact result for baseline export. Use
one phase name for all pages in the run. After capturing the final page, copy
the phase manifest from the console:

```js
copy(JSON.stringify(__XC.export('before'), null, 2))
```

Save that text as `tmp/theme-parity-capture.json`, then build a dated baseline:

```sh
node tools/theme-parity/capture-baseline.js \
  --input tmp/theme-parity-capture.json \
  --date 2026-10-12 \
  --venue "local regtest explorer" \
  --output tools/theme-parity/baseline-2026-10-12.json
```

The output path must not already exist. The builder checks the probe schema on
the manifest and every page, verifies both modes have the expected render-key
count, and records the rule hash per mode, as it does the render hash, because
the rule layer can follow mode (see "What the two layers mean"). A page whose
two modes matched different numbers of rule keys is refused. The probe schema identifies both census lists by count and
hash, so even a same-size property substitution is incompatible. Run
`node tools/theme-parity/capture-baseline.js --self-test` to exercise these
guards.

An existing baseline can be checked without changing it:

```sh
node tools/theme-parity/capture-baseline.js \
  --check tools/theme-parity/baseline-2026-08-20.json
```

That command intentionally rejects the dated baseline with `Render census
property count (23) incompatible with current probe (29)`. The file remains a
historical record, but it cannot be supplied as evidence for the current
29-property probe.

`--check` also requires the `probe` schema object the builder writes. Once a
baseline's pages pass, a missing `probe`, or the bare script path the
2026-08-20 file carries in its place, is refused with `Baseline probe schema
must be an object`, and a schema whose census hashes differ from the current
probe is refused too. `test/unit/content/components/theme_parity_baselines.test.js`
runs this check on every `baseline-*.json` here, so a probe change that strands
a baseline fails the suite.

## Dated baselines in this directory

Both dated baselines are records and stay as they are.

- `baseline-2026-08-20.json` is the M1 tokens capture from the regtest venue,
  taken with the 23-property census and the pre-correction mode flip (see
  "Mode-switch correction (2026-09-05)" below).
- `baseline-2026-10-12-classic.json`, with its screenshots in
  `baseline-2026-10-12-classic/`, is the classic-layout reference for the
  console layout milestones M1 to M3. It was captured with headless Playwright
  from the testnet explorer, not built by `capture-baseline.js`.

The classic file has a different shape from builder output:

- It stores results per mode (`pages.<tag>.light` and `.dark`, each with
  `rule` and `rend`), adds `status` and `consoleErrors`, and has no `probe`,
  `phase`, `layers`, `url` or `anchors`.
- Its `rend` key counts fit the current 31-anchor by 29-property census on
  every page, so the render layer was taken with the current probe.
- Its rule hashes differ between light and dark on `coin_home` (`57f9d752` and
  `bd312d81`) and `market` (`9e7495f9` and `4b513a3b`), and match on the other
  four pages, with equal key counts in each pair. That is expected on the
  current tree: `coin_home` mounts stat tiles, whose rule values follow mode,
  and the `market` split is consistent with an empty chart (see "What the two
  layers mean"). The file records hashes only, so which keys moved is not
  recorded.

`--check` refuses the classic file with `Page coin_home.anchors must have
matched/total form`. Compare against it by hash, per mode. Before a comparison
against the classic layout counts as schema-checked evidence, re-capture it
through the builder as a new dated baseline.

When a hash does not reproduce, ask the page what moved rather than guessing:

```js
const a = JSON.parse(localStorage['__xc:before:coin_home|light|rend']);
const b = JSON.parse(localStorage['__xc:after:coin_home|light|rend']);
Object.keys(a).filter(k => a[k] !== b[k]).map(k => [k, a[k], b[k]]);
```

## What the two layers mean

**rule** - every property a rule in `xchain.css` / `xchain-charts.css`, a
theme's `tokens.css`, or a component's `component.css` declares, read back as
the computed value on the first element that rule matches. Derived from the
stylesheet at runtime, so it cannot fall behind the CSS.

Because it reads computed values, the rule layer follows mode wherever one of
those values does: a declared value that resolves through a token the theme's
dark block redefines, or through a Bootstrap `--bs-*` variable that
`data-bs-theme` switches, on a page where an element matches the rule. Run in
headless Chrome on minimal pages carrying the classic theme (2026-10-14), the
probe found these keys differing between light and dark, while a page that
rendered none of them agreed in both modes:

- `.xc-chart-nodata | color`, through `--xc-chart-nodata-color`. That element
  exists only when a chart renders with no data, so whether it appears depends
  on the venue's chart data.
- `.xc-stat-tile` background and border colours, through `--bs-body-bg` and
  `--bs-border-color`. `coin_home` mounts four stat tiles on every load, so its
  rule hash differs between modes on every venue.
- `.xc-badge` background and border colours, through `--bs-secondary-bg` and
  `--bs-border-color`.

The countdown and timeline component sheets read the same `--bs-*` variables,
and the chart tooltip (created on the first hover) reads tokens layered over
them, so a page rendering one of those would differ too. That list comes from
reading the current CSS, not from a proof that nothing else follows mode.
Compare rule hashes per mode, and only between captures whose pages rendered
the same elements.

The probe picks those sheets out of `document.styleSheets` with a hand-written
`SHEET` pattern, so a first-party sheet the template links and that pattern
does not name is read by nothing. The component sheets sat in exactly that gap
between 2026-09-02 and the pattern being widened; `theme-token-literal-gate`
now checks the pattern against `template.html`'s own link list so the next one
fails the suite instead of vanishing. A theme's `tokens.css` can also pull sheets
in with `@import` (the console theme imports four component overrides), and an
imported sheet never appears in `document.styleSheets`: the probe follows each
import rule's own `styleSheet` under the same `SHEET` test, refuses a capture
whose first-party import came back empty or missing (Chrome hands a 404 import
an empty sheet, not a null one), and the gate checks the pattern against
every `themes/*/tokens.css` import target too. The `baseline-2026-08-20.json` capture
predates the component layer: its per-page `cssRules` counts are one revision
behind, and so is its rule hash on any page that now mounts a component
(`coin_home` has mounted stat tiles since 2026-09-26).

**rend** - a fixed census of 31 anchor selectors x 29 properties, read
regardless of which stylesheet won. This layer does differ between modes, so it
is the one that can catch a dark-mode regression. The census covers every box
property on all four sides. It held 23 properties when the 2026-08-20 baseline
was captured, so a rend capture taken before that change is not comparable with
one taken after it; compare only pairs captured with the same probe. The six
properties added on 2026-10-07 are `border-right-color`, `border-left-width`,
`border-right-width`, `padding-right`, `margin-left` and `margin-right`.

**Layout-derived keys** (widths, heights, margins, offsets) are read
layout-independently in both layers: `getComputedStyle` returns the USED
value for these, which layout renegotiates against page content - an auto
margin resolves to slack pixels, table auto-layout redistributes a declared
column width by fractions of a pixel - so on a live chain they moved between
captures with no CSS change. The rule layer resolves their DECLARED text
through the element's custom properties (the mechanism state rules already
use); the render census reads the Typed OM `computedStyleMap`, where an auto
margin is still `auto`. The keys stay in the census: a real CSS change on
them still flags (proven below), while content drift no longer can. Without
Typed OM the probe refuses the capture instead of falling back to used values.

Both layers are needed. The rule layer sees mode only through the few rules
whose declared values follow it, and only on pages that render them, so a
dark-mode acceptance test riding on it would pass vacuously wherever none
render.

## The blind spot, stated plainly

When measured on 2026-08-20, across the six pages captured then, only
**79 of the 120** selectors in the two page-level stylesheets (`xchain.css` and
`xchain-charts.css`) were instantiated, on the tokenized tree; the figure is the
`coverage` block of `baseline-2026-08-20.json`. The uncovered 41 included the
whole `.xc-chart*` family, the external-explorer glyphs, the `#transaction`
detail table, and the row colours `xchain.js` applies only to non-valid or
negative rows.

That measurement is dated, and it is not a statement of current coverage:

- The 120 counts the page-level sheets only. The per-component `component.css`
  sheets landed after that capture and are not in the count, and pages now
  mount components (`coin_home` has mounted stat tiles since 2026-09-26).
- It is a selector count, so the later render-census property change does not
  touch it, but that file's hashes are not evidence for the current probe (see
  "Mode-switch correction (2026-09-05)").
- No later baseline records coverage: `baseline-2026-10-12-classic.json` has no
  `coverage` block. Current runtime coverage cannot be stated until a fresh
  `baseline-<date>.json` is captured with the current probe.

A rule no page instantiates cannot be proven at runtime by any amount of
capturing. That is why the static token-literal gate is a
separate acceptance test rather than a nicety: it covers all 120, plus the
component sheets, by reading the stylesheet text, while this probe proves only
the selectors that actually render on the captured pages.

## Falsification record (2026-08-20)

The probe was broken deliberately before it was trusted:

- Overriding one declared value (`.footer` background) moved BOTH layer hashes
  (`aceeaaac`->`790eacd2`, `78537a2d`->`b6e4b513`) and the diff named exactly
  the one property that moved. Removing the override restored both hashes
  byte-exact.
- The `var()` resolution used for `:hover`/`:visited` rules was verified
  directly, in both its plain and its fallback form.
- One earlier falsification attempt was itself wrong: it injected a `<style>`
  element, which the probe correctly ignores because it carries no `href`. The
  probe was right and the test was wrong; recorded because the same mistake
  would otherwise be made again.

The layout-derived handling was driven and falsified the same way
(2026-08-20), against the two false movements the acceptance run produced:

- Hiding the home page's content resolved the footer's `mt-auto` slack from
  0px to 1100px - the exact class of movement the old probe reported as a CSS
  change - and the render hash did not move. Re-adding a REAL margin via a
  stylesheet moved the hash and the diff named `.footer | margin-top`
  (`auto` -> `10px`); removing it restored the hash exactly. (An injected
  `<style>` is the right lever HERE: only the rule layer ignores href-less
  styles - the render census reads whatever won, whatever its source.)
- Widening a transaction-table cell swung `th.record`'s used width from
  105.047px to 242.328px and the rule hash did not move, because the key now
  records the declared `75px`. Changing the token feeding that width to 80px
  moved the hash and named both `th.record | width` and `th.block | width`;
  restoring the token restored the hash exactly.

An earlier cut of the probe silently captured NOTHING and reported a clean
0-key "parity proof": Chrome gives every `CSSStyleRule` an empty `.cssRules`
list for CSS nesting, so a naive container check swallowed all 105 rules.
Recursion is now guarded on `.cssRules.length`.

## Mode-switch correction (2026-09-05)

The probe flipped `data-bs-theme` on `documentElement`, while `updateTheme()`
in `src/content/js/xchain.js` writes it on `body` and
`themes/classic/tokens.css` declares the `--xc-*` surface tokens on whichever
element carries the attribute. On a page the application had already marked
dark, `body`'s own declarations kept winning over the inherited root values, so
BOTH captures measured dark surfaces and the `rend` layer compared a mode
against itself. The flip happens on `body` now, and the probe reads the
rendered surface colours back off `body`: two identical readings are rejected
rather than recorded.

Two consequences for anyone reading older evidence:

- The per-mode `rend` hashes in `baseline-2026-08-20.json` were produced by the
  old flip, so which mode each of them actually measured depends on the mode
  the capturing page happened to be left in, which was never recorded. That
  file is a dated record and stays as it is; **re-capture a fresh
  `baseline-<date>.json` with the corrected probe before treating a light/dark
  comparison as evidence**, and do that before the pending pre-prod
  theme-parity re-record rather than after it.
- `test/unit/content/components/theme_parity_probe.test.js` executes the probe in jsdom and pins
  both behaviours: the light and dark captures of a page marked dark must
  render differently, the same page must yield the same hash pair whichever
  mode it arrived in, and a degenerate capture must return `invalid` and write
  nothing. Every one of those assertions fails against the pre-correction
  probe, which is the point of them.
