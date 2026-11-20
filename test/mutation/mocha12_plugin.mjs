import Module from 'node:module';

const originalResolveFilename = Module._resolveFilename;
const mochaCliHelper = /[/\\]mocha[/\\]lib[/\\]cli[/\\](?:run-helpers|options|collect-files)$/;

function resolveMochaCliHelper(request, parent, isMain, options) {
  try {
    return originalResolveFilename.call(this, request, parent, isMain, options);
  } catch (error) {
    // Mocha 12 renamed these CommonJS files to .cjs, while the Stryker 10
    // runner still resolves their extensionless Mocha 11 paths.
    if (error.code === 'MODULE_NOT_FOUND' && mochaCliHelper.test(request)) {
      return originalResolveFilename.call(this, `${request}.cjs`, parent, isMain, options);
    }
    throw error;
  }
}

Module._resolveFilename = resolveMochaCliHelper;

let mochaRunner;
try {
  mochaRunner = await import('@stryker-mutator/mocha-runner');
} finally {
  Module._resolveFilename = originalResolveFilename;
}

export const strykerPlugins = mochaRunner.strykerPlugins;
export const strykerValidationSchema = mochaRunner.strykerValidationSchema;
