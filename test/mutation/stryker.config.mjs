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
    'src/utility.js',
    'src/db.js',
    'src/XChainExplorer.js',
    'src/config.js',
    '!src/content/**',
    '!src/ssl/**',
    '!src/configs/**'
  ],
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
      'test/unit/openapi-coverage.test.js'
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
