/**
 * Regression test helper — reuses the integration DB setup.
 *
 * Regression tests use the same baseline seed as integration tests
 * to maintain a stable, version-controlled reference dataset.
 */

'use strict';

const db = require('../../integration/helpers/db-setup');

module.exports = db;
