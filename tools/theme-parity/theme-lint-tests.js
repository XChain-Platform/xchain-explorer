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

  it('rejects an html route with neither a page declaration nor a stored layout', () => {
    const collected = themeLint.collectRouteEntries();
    assert.deepEqual(themeLint.lintRouteSchemas(collected.routes, collected.hasSchema), []);

    const existingHtml = 'home.html';
    assert.equal(fs.existsSync(path.join(themeLint.HTML_DIR, existingHtml)), true);
    const fallback = themeLint.collectRouteEntries({
      routes: { '/stored': existingHtml, '/list': 'actions.html', '/missing': 'missing.html' },
      pageLayoutsFile: path.join(themeLint.LAYOUT_DIR, 'missing-page-layouts.json'),
      listPage: { has: (file) => file === 'actions.html' },
    });
    assert.match(fallback.source, /list-pages\.json/);
    assert.match(fallback.source, /content\/html/);
    assert.deepEqual(
      themeLint.lintRouteSchemas(fallback.routes, fallback.hasSchema),
      ['/missing -> missing.html has no page layout schema'],
    );
  });

  it('reports the shipped repository accurately through the combined gate', () => {
    const report = themeLint.lintAll();
    assert.deepEqual(report.componentSchemas, []);
    assert.deepEqual(report.themeTokens, []);
    assert.deepEqual(report.routeSchemas, []);
  });
});
