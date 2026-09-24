# Theming the XChain Explorer

This is the authoring guide for explorer themes: how to build one, how it is
selected at request time, and what each layer of the system lets you change.
It assumes no familiarity with the composer or theme-resolution source; every
mechanism below is described in full from the theme author's side.

A theme is a plain folder under `src/content/themes/`. Nothing in this system
builds, bundles, transpiles, or minifies a theme's files: the explorer is a
zero-build service, and a theme ships exactly the files it contains, served as
static assets and read directly at render time.

## The four layers

A theme can change the explorer at four increasingly deep layers, and you do
not have to use all four:

1. **Skin** - CSS custom properties only (`tokens.css`). Recolors and
   resizes; touches no markup and no behavior.
2. **Layout** - the data that drives page composition (column sets, row
   order, which fields show). Rearranges what is already on a page.
3. **Component** - a replacement `template.html`, `init.js`, or
   `component.css` for one named component, or a brand new component the
   theme brings itself.
4. **Full theme** - any combination of the three above, plus a `custom.js`
   entry point for behavior that does not belong inside a single component.

Each layer is additive. A skin-only theme is a valid, complete theme; a full
theme is the same mechanism used four times over.

## Constraints every theme must respect

These carry over from the platform's own rules for the explorer as a whole,
and apply to every theme regardless of which layers it uses:

- **No build step.** A theme's JavaScript is a plain script loaded with a
  `<script src="...">` tag, its CSS is a plain stylesheet loaded with
  `<link>`. Nothing is compiled.
- **No new API surface.** A theme changes what is already rendered from
  data the explorer already exposes; it does not call new endpoints or
  reshape the JSON API.
- **Read-only.** Nothing a theme does writes to a database or to any
  request the explorer did not already make.
- **Content-Security-Policy unchanged.** Do not rely on inline `<script>`
  execution or on `eval`. Data passed from the server to the browser
  (layout config, mount manifests) travels as `<script type="application/json">`
  and is read with `JSON.parse`, never executed.
- **Classic parity.** A theme changing the *default* rendering of a shared
  page (as opposed to opting into its own layout or component) must not move
  what classic renders. The safest rule of thumb: a skin-only theme changes
  values, never markup; a layout or component override is scoped to the
  pages and components it explicitly names.

## Anatomy of a theme directory

```
src/content/themes/<name>/
    theme.json              required
    tokens.css              required
    layouts/                optional - layout overrides
        list-pages.json
        action-detail-cards.json
    components/             optional - component overrides
        <component-name>/
            template.html
            init.js
            component.css
    custom.js               optional - theme-wide behavior
```

`<name>` must match `^[a-z0-9][a-z0-9-]*$` (lowercase letters, digits, and
internal hyphens, starting with a letter or digit). Any other name is
rejected outright, the same way a name that tried to climb out of the themes
directory (`../classic`) is rejected: it never resolves and is treated as
unknown.

`theme.json` holds exactly two fields:

```json
{
    "name": "my-theme",
    "extends": "classic"
}
```

`name` should match the directory name. `extends` is optional; omit it (or
set it to `null`/`""`) to build directly on the explorer's own defaults with
no parent theme in between. Every theme that does set `extends` must
eventually bottom out at a theme with no `extends` of its own (typically
`classic`, the theme that ships with the explorer) - a chain that loops back
on itself, or that names a theme that does not exist, never resolves.

`tokens.css` is the one file every theme must ship, even a theme that
overrides nothing else: it is what proves the theme resolves to something
render-able. An empty-but-valid `tokens.css` is enough for the directory to
count as a theme; you only add rules to it once you want to change how
something looks.

## How a theme gets selected

The explorer resolves one theme per request, in this order of precedence,
highest first:

1. **`?theme=<name>` query parameter.** Meant for preview: appending it to
   any URL renders that page with the named theme, and removing it restores
   whatever the request would otherwise have gotten. It does not persist
   across requests by itself.
2. **`xc_theme` cookie.** Set this to make a choice stick across requests
   without a query parameter on every link. (A theme's own UI, such as a
   theme picker built as a component, is expected to be what sets this
   cookie; the picker itself is ordinary client-side code that writes
   `document.cookie`.)
3. **Configured default.** The operator's `EXPLORER_DEFAULT_THEME`
   environment variable, read live on every request. Absent that, the
   explorer defaults to `classic`.

If the name selected by the highest-precedence source present does not
resolve (unknown name, broken `extends` chain, missing `tokens.css`), the
explorer does not render a broken page and does not silently pick something
else at random: it logs a `THEME_RESOLUTION_FALLBACK` warning naming both the
theme that was requested and the theme it fell back to, then serves the next
theme down in precedence. If the configured default itself does not resolve,
the explorer falls all the way back to `classic`, which is why `classic`
must always be present, always resolve, and never be the thing you delete
when adding a new theme.

### The extends chain

`extends` builds a chain from a root theme down to the one that was
selected. `skin-demo`, the explorer's built-in fixture theme, sets
`"extends": "classic"`, so requesting `skin-demo` resolves the chain
`[classic, skin-demo]`. Every file layer below (`tokens.css`, a layout file,
a component override) is looked up along this same chain, walked from the
root toward the selected theme, and the most specific theme that supplies a
given thing wins. A theme only needs to include what it actually changes;
anything it omits is inherited from further up its own chain.

For `tokens.css` specifically, "the most specific one wins" happens through
the browser's own CSS cascade rather than through any merging logic: the
explorer links every stylesheet in the chain, root first, in the page
`<head>`, so a custom property redeclared by a more specific theme simply
overrides the declaration earlier in the same cascade, and any property a
theme does not redeclare keeps the value declared further up the chain.

## Layer 1: a skin-only theme

A skin-only theme ships `theme.json` and `tokens.css` and nothing else. It
recolors, resizes, and restyles the explorer by redefining CSS custom
properties; it introduces no new markup and no new behavior, so there is
nothing for it to get wrong beyond the values themselves.

Every visual decision the explorer's own stylesheets make (`css/xchain.css`,
`css/xchain-charts.css`) and every stylesheet shipped by a component under
`src/content/components/*/component.css` reads its colors, sizes, and
spacing from a `--xc-*` custom property rather than a literal value. A skin
changes what those properties resolve to; it never needs to touch a
selector.

### Steps

1. Create `src/content/themes/<name>/theme.json`:
   ```json
   { "name": "<name>", "extends": "classic" }
   ```
2. Create `src/content/themes/<name>/tokens.css`. Start from a `:root`
   block and redefine only the tokens you want to change:
   ```css
   :root {
       --xc-footer-bg: #1b2436;
       --xc-highlight-bg: #ffd873;
   }
   ```
   Everything you leave out inherits from `classic` through the extends
   chain.
3. If your theme should also change the dark-mode surface, add a
   `[data-bs-theme="dark"]` block. None of the explorer's own stylesheets
   choose a rule per mode; the mode switch happens entirely by redefining
   tokens under this selector, exactly the pattern `classic`'s own
   `tokens.css` uses for its dark-mode values.
4. To repaint the page background, body text, links, borders, and muted
   text (not just the explorer's own chrome), redefine the
   `--xc-surface-*` family. `classic` sets these to Bootstrap's own default
   values as a bridge; a skin that redefines them moves the whole page, not
   only the elements the explorer's stylesheets style directly.
5. Preview it without touching configuration: request any page with
   `?theme=<name>` appended. Remove the parameter to see the previous
   theme again.
6. To make the theme selectable for real, either set
   `EXPLORER_DEFAULT_THEME=<name>` for every visitor, or add a control
   (a theme-toggle-style component, or a link with the query parameter)
   that sets the `xc_theme` cookie for a visitor who picks it.

Two things are easy to get wrong in a skin, both caught by the token-literal
gate the platform runs across every shared stylesheet: introducing a new
literal value (a hex code, a raw pixel size) into `xchain.css` or a shared
`component.css` instead of a token, and leaving a token your `tokens.css`
introduces unresolved (declared nowhere in the chain, including your own
theme). Fix the first by moving the literal into a new `--xc-*` property in
`classic`'s `tokens.css` first, so every theme (including yours) can then
override it; fix the second by declaring the token in your `tokens.css` or
by inheriting it from a parent theme that already does.

## Layer 2: a layout override

A layout override changes what is already on a page (which columns a table
shows, in what order, which detail rows appear) without introducing new
markup or new behavior. It is the right tool when the change you want is
"drop this column" or "put this row first," not "add a component that isn't
here."

Two shared layout files drive most of the explorer's collapsible content:

- `src/content/layouts/list-pages.json` - one entry per list page (all
  actions, all blocks, all addresses, and so on), each entry naming the
  page's icon, heading, the `data-table` component's column set, and its
  SEO metadata.
- `src/content/layouts/action-detail-cards.json` - one entry per
  action-detail card type, each entry naming the ordered rows the
  `detail-card` component renders.

Both files are lists of named entries (columns, or rows) that can each carry
a `hidden` flag and a numeric `order`. This is the same mechanism the
`data-table`, `detail-card`, and `tab-panel` components already use to
resequence their own content, so an override does not need any new runtime
support to take effect: it reads through the identical `hidden`/`order`
resolution every one of those components already applies.

### How an override resolves

A theme overrides a layout file by shipping a file of the same name at
`src/content/themes/<name>/layouts/<file>.json`. You do not have to restate
every page or every card type: name only the top-level keys you want to
change, and provide the corrected entry in full for each one you name. Keys
you omit pass through unchanged from further up the theme's `extends`
chain, exactly like a token your `tokens.css` does not redeclare, and if no
theme in the chain overrides a given key at all, the shared file under
`src/content/layouts/` (the platform's own baseline) supplies it, which is
also exactly what renders today with no theme override in play at all.

### Worked example

Suppose your theme wants the "All Actions" list page to drop the "Source"
column and put "Action" first. `src/content/layouts/list-pages.json` names
that page's entry `actions.html` with a `columns` array; your theme repeats
only that one entry, in `src/content/themes/<name>/layouts/list-pages.json`:

```json
{
    "actions.html": {
        "columns": [
            { "label": "Action",  "cls": "asset-name" },
            { "label": "#",       "cls": "record" },
            { "label": "Block",   "cls": "block" },
            { "label": "Time",    "cls": "time" },
            { "label": "Source",  "cls": "",     "hidden": true },
            { "label": "",        "cls": "view" }
        ]
    }
}
```

Every other page entry in `list-pages.json` is left to inherit unchanged.
The same pattern applies to `action-detail-cards.json`: name the card type,
supply its `rows` with `hidden`/`order` adjustments, and leave every other
card type alone.

## Layer 3: component overrides

Every reusable piece of chrome and content on an explorer page (the nav bar,
the search box, a data table, a detail card, a QR code panel) is a
*component*: a named, registered unit with a declared prop table, a server
side `template.html`, an optional `component.css`, and a client-side
`init.js` that registers a mount function. A component is replaced by
shipping a same-named replacement under the theme's own `components/`
directory; nothing about a component being platform-shipped by default
makes it any less replaceable.

```
src/content/themes/<name>/components/<component-name>/
    template.html      optional - replaces the server-rendered markup
    init.js             optional - replaces the client-side mount behavior
    component.css       optional - replaces or augments the component's styles
```

You do not have to supply all three. A theme that only wants to change how
a component *behaves* on mount (add a client-side interaction, change what
a prop does) ships only `init.js`; a theme that wants different *markup*
(the shape of the nav bar, not just its colors) ships `template.html`; a
theme that wants different rules on top of the shared stylesheet ships
`component.css`.

### Overriding markup

A component's `template.html` is a plain HTML fragment with `{SLOT}`
placeholders the server fills in (see `nav`'s template, which nests
`{SEARCH_BOX}` and `{THEME_TOGGLE}`, or `stat-card`'s, which fills `{ID}`,
`{ICON}`, `{TITLE}`, and `{BODY}`). A theme's own `template.html` for that
component must fill the same named slots the platform's does, because the
composer supplies the same substitution values regardless of which
template rendered; what changes is the markup surrounding those slots. This
is exactly how a theme replaces the shared mega-menu-style `nav` component
with a different structure (a sidebar, for instance) without the platform
shell (`template.html`'s `{NAV}` placeholder) or any other page needing to
know or care which one is active.

### Overriding behavior

Every component's client-side `init.js` registers itself with the global
component registry, `XCComponents`, by name:

```js
XCComponents.register('my-component', {
    props: {
        title: { type: 'string', required: true },
        open:  { type: 'boolean', default: true }
    },
    mount: function(el, props, ctx){
        // el:    the resolved mount point
        // props: validated against the prop table above, defaults filled in
        // ctx:   { coin, network, name, theme } - ambient page context
        el.textContent = props.title;
        return { mounted: true };
    }
});
```

Registering a second time under a name that is already registered is not an
error, it is how an override takes effect: the registry logs that the name
was re-registered and keeps the newest definition. A theme's `init.js`
(loaded after the platform's own, or after a parent theme's) is exactly
that second registration. There is nothing else to wire up: any page that
already mounts `my-component` by name now gets your `mount` function
instead, with no change to the page itself.

## Layer 4: a full theme

A full theme combines every layer above and adds one thing none of them
cover on their own: a `custom.js` entry point for behavior that spans more
than one component, or that has nowhere else to live (wiring a sidebar's
collapse state to a cookie, mounting a component into a container the theme
itself creates rather than one a shared page already renders).

`custom.js` is loaded once per active theme, after every platform script and
every component script, in the same root-to-selected order the theme's
`extends` chain resolves everything else in: a parent theme's `custom.js`
(if it has one) runs before the child's, so a child can rely on whatever the
parent already set up and still override it. Like every other file in a
theme's directory, `custom.js` is optional; a theme with only a skin, or
only a skin plus a layout override, never has one.

Because `custom.js` runs after `XCComponents` and every component's
`init.js`, it can do anything a component's own script can do, just scoped
to the whole page rather than one mount point:

```js
(function(){
    'use strict';
    // Re-register an existing component's mount behavior for this theme only.
    XCComponents.register('nav', { props: { /* ... */ }, mount: function(el, props, ctx){
        /* sidebar-specific wiring */
    }});

    // A new theme-only component must load its own three runtime assets before
    // it mounts. The complete pattern appears under "Theme-only loading".
})();
```

### Worked example: a full theme end to end

Say you are building a theme that replaces the classic mega-menu with a
sidebar and shows a denser, card-based layout on the coin home page. As a
full theme, that decomposes into the same four layers, combined:

1. **Skin** - `tokens.css` redefines spacing and surface tokens for a
   denser, dark-first look (smaller `--xc-table-cell-padding`, dark
   `--xc-surface-*` values as the default rather than only under
   `[data-bs-theme="dark"]`).
2. **Layout** - `layouts/list-pages.json` hides lower-priority columns
   across the busiest tables so more rows fit without horizontal scroll.
3. **Component** - `components/nav/template.html` and
   `components/nav/init.js` replace the mega-menu with sidebar markup and
   the interaction (collapse/expand, active-route highlighting) it needs.
4. **Full theme** - `custom.js` restores whichever collapse state the
   visitor last left the sidebar in (reading a cookie or `localStorage` the
   theme owns) and mounts any component the sidebar needs into a container
   it builds itself, rather than one the shared page markup would have had
   to add just for this one theme.

Nothing above touches a file outside the theme's own directory. That is the
test for whether a change belongs in a theme at all: if expressing it
requires editing a shared page, a shared layout file, or a shared component
under `src/content/components/`, it is not a theme change, it is a platform
change, and belongs there instead (very possibly by first making the thing
you need overridable, the same way `nav`, `list-pages.json`, and every
other override point above already had to be made overridable before a
theme could use them).

## Building a new component

Everything above assumes the component you are overriding already exists.
Building a brand new one, whether it ships with the platform for every
theme to use or lives entirely inside your own theme, follows the same
four-file shape every existing component uses:

```
<component-name>/
    component.json      the declared prop table
    template.html        server-rendered markup, with {SLOT} placeholders
    component.css         styles, reading --xc-* tokens rather than literals
    init.js                registers the component with XCComponents
```

`component.json` documents each prop's type (`string`, `number`, `boolean`,
`array`, or `object`), whether it is required, and any default:

```json
{
    "name": "my-component",
    "description": "One sentence describing what this component is for.",
    "props": {
        "title": { "type": "string", "required": true },
        "open":  { "type": "boolean", "default": true }
    }
}
```

This file is documentation and a validation contract, not something the
browser fetches at runtime: the prop table your `init.js` passes to
`XCComponents.register` is what the registry actually validates against, so
keep the two in agreement. An undeclared prop in a manifest entry is a
validation error, not a silently ignored extra, precisely so a typo'd prop
name fails loudly instead of quietly mounting with defaults.

Mounting happens one of two ways:

- **From a mount manifest.** A page (or a layout override, per Layer 2)
  emits a JSON block naming which components to mount, on which elements,
  with which props: `[{ "el": "my-mount-point", "component":
  "my-component", "props": { "title": "Live" } }]`. The platform's runtime
  reads this block once the page's ambient context (coin, network) is
  established and mounts everything it names, in order.
- **Directly, from `custom.js`.** Call `XCComponents.mount(target, name,
  props, ctx)` yourself, against any element already on the page or one you
  created. This is the path a theme-only component takes, since nothing in
  a shared page's manifest can name a component that only exists inside
  your theme.

A platform-level component (one every theme should be able to use, not just
yours) also needs `template.html`'s `<script>`/`<link>` tags added so every
page loads it, and its name added to the platform's own component registry
tests, so a component that is registered but never loaded, or never
inventoried, fails a test instead of silently missing from every page. A
theme-only component skips both shared-platform changes. Its active theme's
`custom.js` loads all three runtime files from the theme directory and mounts
the component itself.

### Theme-only loading: a complete example

The explorer serves `src/content/themes/` at `/themes/`, so these source files:

```
src/content/themes/status-board/
    theme.json
    tokens.css
    custom.js
    components/live-status/
        component.json
        template.html
        component.css
        init.js
```

are available to the browser below
`/themes/status-board/components/live-status/`. Merely putting the files there
does not load them. The theme engine automatically loads `custom.js` for the
active theme, but a brand-new component is deliberately absent from the shared
page shell and mount manifest. That `custom.js` must therefore do four things,
in this order:

1. Add a `<link>` for `component.css`.
2. Fetch `template.html` and place the returned fragment in a mount point.
3. Add a `<script>` for `init.js`, whose execution registers the component.
4. Wait until those loads finish, then call `XCComponents.mount`.

For this browser-loaded case, `template.html` is a static fragment. It is not
passed through the server-side `{SLOT}` substitution used by an override of a
shared component. Put the fragment's fixed structure in the file and have the
registered mount function fill its prop-dependent text or state.

`components/live-status/template.html`:

```html
<section class="xc-live-status" aria-live="polite">
    <h2 class="xc-live-status-title"></h2>
    <span class="xc-live-status-value">Connecting</span>
</section>
```

`components/live-status/component.css`:

```css
.xc-live-status {
    color: var(--xc-surface-body-color);
    background: var(--xc-surface-secondary-bg);
    border: var(--xc-table-border-width) solid var(--xc-surface-border-color);
    padding: var(--xc-table-cell-padding);
}
```

`components/live-status/init.js` registers the name. It does not mount itself:

```js
(function(){
    'use strict';

    XCComponents.register('live-status', {
        props: {
            title: { type: 'string', required: true }
        },
        mount: function(el, props, ctx){
            el.querySelector('.xc-live-status-title').textContent = props.title;
            el.querySelector('.xc-live-status-value').textContent =
                ctx.coin ? ctx.coin + ' connected' : 'Explorer connected';
            return { mounted: true };
        }
    });
})();
```

Finally, `custom.js` loads the files from their public theme URLs. Loading the
script through a `src` attribute, rather than fetching and evaluating its text,
keeps the existing Content-Security-Policy intact. These requests are static
asset reads under `/themes/`; they do not add an API endpoint.

```js
(function(){
    'use strict';

    var base = '/themes/status-board/components/live-status/';

    function loadStylesheet(href){
        return new Promise(function(resolve, reject){
            var link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = href;
            link.onload = resolve;
            link.onerror = function(){ reject(new Error('Could not load ' + href)); };
            document.head.appendChild(link);
        });
    }

    function loadScript(src){
        return new Promise(function(resolve, reject){
            var script = document.createElement('script');
            script.src = src;
            script.onload = resolve;
            script.onerror = function(){ reject(new Error('Could not load ' + src)); };
            document.head.appendChild(script);
        });
    }

    function loadTemplate(src){
        return fetch(src, { credentials: 'same-origin' }).then(function(response){
            if(!response.ok)
                throw new Error('Could not load ' + src + ': HTTP ' + response.status);
            return response.text();
        });
    }

    Promise.all([
        loadTemplate(base + 'template.html'),
        loadStylesheet(base + 'component.css'),
        loadScript(base + 'init.js')
    ]).then(function(assets){
        var host = document.createElement('div');
        host.id = 'status-board-live-status';
        host.innerHTML = assets[0];
        document.body.appendChild(host);
        XCComponents.mount(host, 'live-status', { title: 'Network status' });
    }).catch(function(error){
        XCLogger.error('status-board: ' + error.message);
    });
})();
```

`Promise.all` is load-bearing here: mounting earlier can race the template,
the CSS, or registration by `init.js`. If the component belongs at a particular
place in the page, append `host` to that container instead of `document.body`.
If several components share the same loader, factor these three helper
functions into the theme's `custom.js` once and call them with a different
component base URL each time.

## Checklist for shipping a theme

- [ ] `theme.json` names the theme and, if it builds on another, sets
      `extends` to a theme that itself resolves.
- [ ] `tokens.css` exists, even if empty for a layout-only or
      component-only theme.
- [ ] Every token your `tokens.css` introduces is declared somewhere in
      your theme's own chain; nothing is left dangling.
- [ ] Every layout file you ship names only the pages or cards you are
      actually changing.
- [ ] Every component override you ship fills the same slots (for a
      `template.html` override) or the same declared props (for an
      `init.js` override) as the component it replaces.
- [ ] Every theme-only component has its stylesheet, template, and registration
      script loaded by `custom.js`, and mounts only after all three are ready.
- [ ] `?theme=<name>` renders every page you expect it to, and removing
      the parameter restores the previous theme cleanly.
- [ ] Nothing outside `src/content/themes/<name>/` changed to make any of
      the above true.
