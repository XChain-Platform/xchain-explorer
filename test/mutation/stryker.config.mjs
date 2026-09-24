/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  mutate: [
    'src/lib/utility.js',
    // src/db/index.js is the composition root left after proposal B; the
    // queries it used to hold live in these split directories now, so the
    // facade alone would leave every extracted method unmutated.
    'src/db/**/*.js',
    'src/XChainExplorer.js',
    'src/config.js',
    '!src/content/**',
    '!src/ssl/**',
    '!src/coin-config/**'
  ],
  // xchain-vm is gitignored and, in a worktree checkout, arrives as a symlink
  // outside the sandbox root; Stryker's plain copyFile cannot follow it into a
  // directory and aborts the whole run before any mutant executes. Nothing
  // under it is mutated (it is not in the `mutate` list above), so excluding
  // it from the sandbox copy costs no coverage.
  ignorePatterns: ['xchain-vm'],
  // This project ships no TypeScript and no `// @ts-check` file, so there is no
  // type error for Stryker's default `// @ts-nocheck` injection to guard
  // against. Left at its default, that injection rewrites every HTML file's
  // inline <script> content too (default pattern covers `src/**/*.html`),
  // which lands inside the page markup list_page.js composes and breaks
  // test/unit/render/list_page_composition.test.js on the ready-block regex.
  disableTypeChecks: false,
  testRunner: 'mocha',
  mochaOptions: {
    spec: ['test/unit/**/*.test.js'],
    // Tests that assert on SOURCE TEXT rather than behaviour. They read a src
    // file off disk and grep it (for a render-branch list, for route ordering),
    // so under Stryker they read the instrumented sandbox copy and fail on
    // every run including the dry run, taking the whole run down with them.
    //
    // Dropping them costs no mutation signal by construction: a test that never
    // executes the code cannot kill a mutant of it. They still guard the real
    // tree under `npm test`.
    ignore: [
      'test/unit/ActionManifestConformance.test.js',
      'test/unit/ConsensusPrimitiveConformance.test.js',
      'test/unit/HubMirrorClientConformance.test.js',
      'test/unit/fontawesome-icons.test.js',
      'test/unit/jsonrpc-body-guard.test.js',
      'test/unit/openapi-coverage.test.js',
      // Same source-text-reads-the-sandbox-copy failure as the six above, newly
      // reached now that the mutate globs cover every src/db/** file: both walk
      // every module under src/db/ off disk and parse class bodies with a
      // regex. Stryker's instrumented copy reprints each file, so a nested `if`
      // can land at the 4-space column the regex treats as a class-body method,
      // and the parse finds phantom methods named "if".
      'test/unit/db/core/db_prototype_install.test.js',
      'test/unit/db/core/db_reader_composition.test.js',
      'test/unit/db/guards/ping_empty_pool_guard.test.js',
      // Resolves its sibling-repo path as `../..` from its own test file, which
      // lands on the real platform root when mocha runs from the checkout but on
      // Stryker's `.stryker-tmp/sandbox-*` directory when it runs from the
      // sandbox, so the sibling xchain-indexer checkout it needs is never there.
      // Unrelated to which files are mutated; every mutate target hits this the
      // same way, not only the newly-added src/db/** ones.
      'test/unit/mirror/hub_mirror_bridge_tables.test.js'
    ]
  },
  reporters: ['html', 'json', 'clear-text', 'progress'],
  htmlReporter: {
    fileName: 'reports/mutation/index.html'
  },
  jsonReporter: {
    fileName: 'reports/mutation/results.json'
  },
  thresholds: {
    high: 90,
    low: 80,
    break: null
  },
  concurrency: 4,
  timeoutMS: 30000,
  timeoutFactor: 1.5,
  tempDirName: '.stryker-tmp',
  cleanTempDir: 'always'
};
