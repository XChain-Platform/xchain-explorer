/**
 * Regression test helper — reuses the integration app setup.
 *
 * Boots the explorer against the test MariaDB and returns a
 * supertest-compatible Express app instance.
 */

'use strict';

const { createApp, createTestConfigInfo } = require('../../integration/helpers/app-setup');

module.exports = { createApp, createTestConfigInfo };
