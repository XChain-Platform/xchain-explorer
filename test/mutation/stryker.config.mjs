/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  mutate: [
    '../../src/utility.js',
    '../../src/db.js',
    '../../src/XChainExplorer.js',
    '../../src/config.js',
    '!../../src/content/**',
    '!../../src/ssl/**',
    '!../../src/configs/**'
  ],
  testRunner: 'mocha',
  mochaOptions: {
    spec: ['../../test/unit/**/*.test.js']
  },
  reporters: ['html', 'json', 'clear-text', 'progress'],
  htmlReporter: {
    fileName: '../../reports/mutation/index.html'
  },
  jsonReporter: {
    fileName: '../../reports/mutation/results.json'
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
