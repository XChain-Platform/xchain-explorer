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
3. Paste all of `parity-probe.js` into the devtools console.
4. Capture:
   - before any CSS change: `__XC('coin_home', 'before')`
   - after: `__XC('coin_home', 'after')`
5. Repeat per page, using the tags and URLs recorded in the baseline JSON.

Each call snapshots BOTH light and dark, writes the full snapshots to
localStorage, and returns only fingerprints. Compare those against
`baseline-<date>.json`: every hash must reproduce exactly.

When a hash does not reproduce, ask the page what moved rather than guessing:

```js
const a = JSON.parse(localStorage['__xc:before:coin_home|light|rend']);
const b = JSON.parse(localStorage['__xc:after:coin_home|light|rend']);
Object.keys(a).filter(k => a[k] !== b[k]).map(k => [k, a[k], b[k]]);
```

## What the two layers mean

**rule** - every property a rule in `xchain.css` / `xchain-charts.css`
declares, read back as the computed value on the first element that rule
matches. Derived from the stylesheet at runtime, so it cannot fall behind the
CSS. On the pre-tokenization tree its light and dark hashes are IDENTICAL on
every page, because `xchain.css` declares nothing that resolves per mode.

**rend** - a fixed census of 31 anchor selectors x 23 properties, read
regardless of which stylesheet won. This layer does differ between modes, so it
is the one that can catch a dark-mode regression.

Both layers are needed. The rule layer alone cannot see mode at all, so a
dark-mode acceptance test riding on it would pass vacuously.

## The blind spot, stated plainly

Across the six captured pages, only **77 of the 121** selectors in the two
stylesheets are ever instantiated. The uncovered 44 include the whole
`.xc-chart*` family, the external-explorer glyphs, the `#transaction` detail
table, and the row colours `xchain.js` applies only to non-valid or negative
rows.

A rule no page instantiates cannot be proven at runtime by any amount of
capturing. That is why the static token-literal gate (frontier row 5) is a
separate acceptance test rather than a nicety: it covers all 121 by reading the
stylesheet, while this probe proves the 77 that actually render.

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

An earlier cut of the probe silently captured NOTHING and reported a clean
0-key "parity proof": Chrome gives every `CSSStyleRule` an empty `.cssRules`
list for CSS nesting, so a naive container check swallowed all 105 rules.
Recursion is now guarded on `.cssRules.length`.
