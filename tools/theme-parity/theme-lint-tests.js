'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const themeLint = require('./theme-lint.js');
const fixtures = require('./theme-lint-fixtures.js');

describe('theme lint', () => {
  it('rejects a schema naming an unregistered component or invalid props', () => {
    const real = themeLint.loadComponentRegistry(themeLint.COMPONENT_DIR);
    assert.deepEqual(themeLint.lintComponentSchemas(real, themeLint.collectManifestEntries()), []);
    const schema = {
      pages: {
        ghost: { mounts: [{ component: 'ghost', props: {} }] },
        bad: { mounts: [{ component: 'widget', props: { bogus: 1, rows: 'nope' } }] },
      },
    };
    const entries = themeLint.collectComponentEntries(schema, 'fixture.json');
    const errors = themeLint.lintComponentSchemas(fixtures.WIDGET_REGISTRY, entries);
    assert.deepEqual(entries.map((entry) => entry.source), [
      'fixture.json/pages/ghost/mounts/0',
      'fixture.json/pages/bad/mounts/0',
    ]);
    const message = errors.join('\n');
    assert.match(message, /no component registered as "ghost"/);
    assert.match(message, /widget\.id is required/);
    assert.match(message, /widget has no prop named "bogus"/);
    assert.match(message, /widget\.rows must be a array/);
  });

  it('rejects a token unresolved through an inherited token stylesheet', () => {
    assert.deepEqual(
      themeLint.unresolvedTokens(new Set(['--xc-a']), new Set(['--xc-a', '--xc-b'])),
      ['--xc-b'],
    );
    assert.deepEqual(
      themeLint.lintThemeTokens(themeLint.THEMES_DIR, themeLint.sharedStylesheetRefs()),
      [],
    );
    const report = fixtures.withFixtureThemeChain((directory) =>
      themeLint.themeTokenReport(directory, 'child', new Set(['--xc-child'])));
    assert.deepEqual(report.missing, ['--xc-missing']);
  });

  it('resolves tokens used by sheets a theme tokens.css @imports, and reports bad imports', () => {
    // The imported sheets ship with the theme but no shared-sheet scan reads them, so a
    // typo there passed every check and failed silently in the browser.
    const { report, errors } = fixtures.withFixtureImportingTheme((directory) => ({
      report: themeLint.themeTokenReport(directory, 'child', new Set()),
      errors: themeLint.lintThemeTokens(directory, new Set()),
    }));
    assert.deepEqual(report.missing, ['--xc-import-typo', '--xc-nested-typo']);
    assert.deepEqual(report.badImports, [
      { theme: 'child', from: 'tokens.css', target: './components/absent/component.css', reason: 'does not exist' },
      { theme: 'child', from: 'tokens.css', target: '../base/tokens.css', reason: 'is outside the theme directory' },
    ]);
    assert.deepEqual(errors, [
      'child: tokens.css imports ./components/absent/component.css, which does not exist',
      'child: tokens.css imports ../base/tokens.css, which is outside the theme directory',
      'child leaves --xc-import-typo unresolved in its token inheritance chain',
      'child leaves --xc-nested-typo unresolved in its token inheritance chain',
    ]);
  });

  it('rejects an html route whose file exists but has no schema', () => {
    const collected = themeLint.collectRouteEntries();
    assert.equal(
      collected.source,
      fs.existsSync(themeLint.PAGE_LAYOUTS_FILE)
        ? themeLint.PAGE_LAYOUTS_FILE
        : themeLint.LINT_PAGE_LAYOUTS_FILE,
    );
    assert.deepEqual(themeLint.lintRouteSchemas(collected.routes, collected.hasSchema), []);

    const existingHtml = 'home.html';
    assert.equal(fs.existsSync(path.join(themeLint.HTML_DIR, existingHtml)), true);
    const fallback = themeLint.collectRouteEntries({
      routes: { '/raw': existingHtml, '/list': 'actions.html' },
      pageLayoutsFile: path.join(themeLint.LAYOUT_DIR, 'missing-page-layouts.json'),
      listPage: { has: (file) => file === 'actions.html' },
    });
    assert.equal(fallback.source, themeLint.LIST_PAGES_FILE);
    assert.deepEqual(
      themeLint.lintRouteSchemas(fallback.routes, fallback.hasSchema),
      ['/raw -> home.html has no page layout schema'],
    );

    const catalog = {
      schemas: { html: { layout: 'page.html', regions: [{ name: 'content' }] } },
      pages: { declared: { extends: 'html' }, empty: {} },
    };
    assert.equal(themeLint.hasPageLayoutSchema(catalog, 'declared'), true);
    assert.equal(themeLint.hasPageLayoutSchema(catalog, 'empty'), false);
    assert.equal(themeLint.hasPageLayoutSchema(catalog, 'absent'), false);
  });

  it('reports the shipped repository accurately through the combined gate', () => {
    const report = themeLint.lintAll();
    assert.deepEqual(report.componentSchemas, []);
    assert.deepEqual(report.themeTokens, []);
    assert.deepEqual(report.routeSchemas, []);
  });
});
