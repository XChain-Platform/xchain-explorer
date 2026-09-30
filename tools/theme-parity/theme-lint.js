/**********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 ********************************************************************/

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SRC_DIR = path.join(ROOT, 'src');
const CSS_DIR = path.join(SRC_DIR, 'content', 'css');
const COMPONENT_DIR = path.join(SRC_DIR, 'content', 'components');
const THEMES_DIR = path.join(SRC_DIR, 'content', 'themes');
const LAYOUT_DIR = path.join(SRC_DIR, 'content', 'layouts');
const HTML_DIR = path.join(SRC_DIR, 'content', 'html');
const PAGE_LAYOUTS_FILE = path.join(LAYOUT_DIR, 'page-layouts.json');
const LINT_PAGE_LAYOUTS_FILE = path.join(__dirname, 'page-layouts.json');
const LIST_PAGES_FILE = path.join(LAYOUT_DIR, 'list-pages.json');
const CSS_FILES = ['xchain.css', 'xchain-charts.css'];

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '));
}

function xcVarRefs(css) {
  const refs = new Set();
  for (const match of stripComments(css).matchAll(/var\(\s*(--xc-[\w-]+)/g)) refs.add(match[1]);
  return refs;
}

function xcVarDefs(css) {
  const definitions = new Set();
  for (const match of stripComments(css).matchAll(/(--xc-[\w-]+)\s*:/g)) definitions.add(match[1]);
  return definitions;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadComponentRegistry(componentDir) {
  const registry = {};
  for (const directory of fs.readdirSync(componentDir)) {
    const file = path.join(componentDir, directory, 'component.json');
    if (!fs.existsSync(file)) continue;
    const declaration = readJson(file);
    registry[declaration.name || directory] = {
      props: declaration.props || {},
      mount() {},
    };
  }
  return registry;
}

function collectComponentEntries(value, source, pointer = '', entries = []) {
  if (!value || typeof value !== 'object') return entries;
  if (!Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, 'component')) {
    entries.push({
      source: source + pointer,
      component: value.component,
      props: value.props,
    });
  }
  for (const [key, child] of Object.entries(value)) {
    const childPointer = `${pointer}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;
    collectComponentEntries(child, source, childPointer, entries);
  }
  return entries;
}

function jsonFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...jsonFiles(file));
    else if (entry.isFile() && entry.name.endsWith('.json')) files.push(file);
  }
  return files;
}

function collectManifestEntries(options = {}) {
  const listPage = require(path.join(SRC_DIR, 'render', 'list_page.js'));
  listPage.reset();
  const entries = [];
  for (const file of listPage.pages()) {
    for (const mount of listPage.manifest(listPage.config(file))) {
      entries.push({
        source: `list-pages.json:${file}`,
        component: mount.component,
        props: mount.props,
      });
    }
  }

  const cards = readJson(path.join(LAYOUT_DIR, 'action-detail-cards.json')).cards || {};
  for (const [type, card] of Object.entries(cards)) {
    entries.push({
      source: `action-detail-cards.json:${type}`,
      component: 'detail-card',
      props: { type, rows: card.rows || [], reveal: true },
    });
  }

  const schemaFiles = jsonFiles(LAYOUT_DIR).concat(jsonFiles(THEMES_DIR));
  const pageLayoutsFile = options.pageLayoutsFile
    || (fs.existsSync(PAGE_LAYOUTS_FILE) ? PAGE_LAYOUTS_FILE : LINT_PAGE_LAYOUTS_FILE);
  if (!schemaFiles.includes(pageLayoutsFile)) schemaFiles.push(pageLayoutsFile);
  for (const file of schemaFiles) {
    const source = path.relative(ROOT, file);
    collectComponentEntries(readJson(file), source, '', entries);
  }
  return entries;
}

function lintComponentSchemas(registry, entries) {
  const components = require(path.join(SRC_DIR, 'content', 'js', 'components.js'));
  components.reset();
  for (const [name, declaration] of Object.entries(registry)) {
    components.register(name, declaration);
  }

  const errors = [];
  for (const entry of entries) {
    const result = components.validate(entry.component, entry.props);
    if (!result.ok) errors.push(`${entry.source}: ${result.errors.join('; ')}`);
  }
  return errors;
}

function unresolvedTokens(definedVars, referencedVars) {
  return [...referencedVars].filter((name) => !definedVars.has(name)).sort();
}

function sharedStylesheetRefs() {
  const refs = new Set();
  const files = CSS_FILES.map((name) => path.join(CSS_DIR, name));
  for (const directory of fs.readdirSync(COMPONENT_DIR)) {
    const file = path.join(COMPONENT_DIR, directory, 'component.css');
    if (fs.existsSync(file)) files.push(file);
  }
  for (const file of files) {
    for (const name of xcVarRefs(fs.readFileSync(file, 'utf8'))) refs.add(name);
  }
  return refs;
}

function themeTokenReport(themesDir, themeName, sharedRefs) {
  const resolve = require(path.join(SRC_DIR, 'content', 'themes', 'resolve.js'));
  const chain = resolve.resolveChain(themesDir, themeName);
  if (!chain) return { theme: themeName, chainBroken: true, missing: [] };

  const definedVars = new Set();
  const referencedVars = new Set(sharedRefs);
  for (const name of chain) {
    const css = fs.readFileSync(path.join(themesDir, name, 'tokens.css'), 'utf8');
    for (const token of xcVarDefs(css)) definedVars.add(token);
    for (const token of xcVarRefs(css)) referencedVars.add(token);
  }
  return {
    theme: themeName,
    chainBroken: false,
    missing: unresolvedTokens(definedVars, referencedVars),
  };
}

function lintThemeTokens(themesDir, sharedRefs) {
  const errors = [];
  const themeNames = fs.readdirSync(themesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const themeName of themeNames) {
    const report = themeTokenReport(themesDir, themeName, sharedRefs);
    if (report.chainBroken) {
      errors.push(`${themeName}: extends chain does not resolve`);
      continue;
    }
    for (const token of report.missing) {
      errors.push(`${themeName} leaves ${token} unresolved in its token inheritance chain`);
    }
  }
  return errors;
}

function lintRouteSchemas(routes, hasSchema) {
  const errors = [];
  for (const [route, file] of Object.entries(routes)) {
    if (!hasSchema(file)) errors.push(`${route} -> ${file} has no page layout schema`);
  }
  return errors;
}

function hasPageLayoutSchema(catalog, file) {
  const pages = catalog.pages || {};
  const schemas = catalog.schemas || {};
  let current = pages[file];
  const visited = new Set();
  let layout;
  let regions;
  while (current && typeof current === 'object' && !Array.isArray(current)) {
    if (layout === undefined && typeof current.layout === 'string') layout = current.layout;
    if (regions === undefined && Array.isArray(current.regions)) regions = current.regions;
    if (!current.extends) break;
    if (visited.has(current.extends)) return false;
    visited.add(current.extends);
    const parent = schemas[current.extends];
    if (!parent || typeof parent !== 'object' || Array.isArray(parent)) return false;
    current = parent;
  }
  return typeof layout === 'string' && Array.isArray(regions) && regions.length > 0;
}

function collectRouteEntries(options = {}) {
  const routes = options.routes
    || require(path.join(SRC_DIR, 'explorer', 'routes', 'static_and_html.js')).html;
  const pageLayoutsFile = options.pageLayoutsFile
    || (fs.existsSync(PAGE_LAYOUTS_FILE) ? PAGE_LAYOUTS_FILE : LINT_PAGE_LAYOUTS_FILE);
  if (fs.existsSync(pageLayoutsFile)) {
    const catalog = readJson(pageLayoutsFile);
    return {
      routes,
      hasSchema: (file) => hasPageLayoutSchema(catalog, file),
      source: pageLayoutsFile,
    };
  }

  const listPage = options.listPage || require(path.join(SRC_DIR, 'render', 'list_page.js'));
  return {
    routes,
    hasSchema: (file) => listPage.has(file),
    source: LIST_PAGES_FILE,
  };
}

function lintAll() {
  const route = collectRouteEntries();
  return {
    componentSchemas: lintComponentSchemas(
      loadComponentRegistry(COMPONENT_DIR),
      collectManifestEntries(),
    ),
    themeTokens: lintThemeTokens(THEMES_DIR, sharedStylesheetRefs()),
    routeSchemas: lintRouteSchemas(route.routes, route.hasSchema),
  };
}

module.exports = {
  ROOT,
  CSS_DIR,
  COMPONENT_DIR,
  THEMES_DIR,
  LAYOUT_DIR,
  HTML_DIR,
  PAGE_LAYOUTS_FILE,
  LINT_PAGE_LAYOUTS_FILE,
  LIST_PAGES_FILE,
  CSS_FILES,
  stripComments,
  xcVarRefs,
  xcVarDefs,
  unresolvedTokens,
  loadComponentRegistry,
  collectComponentEntries,
  collectManifestEntries,
  lintComponentSchemas,
  sharedStylesheetRefs,
  themeTokenReport,
  lintThemeTokens,
  lintRouteSchemas,
  hasPageLayoutSchema,
  collectRouteEntries,
  lintAll,
};

if (require.main === module) {
  const report = lintAll();
  const errors = Object.values(report).flat();
  if (errors.length) {
    for (const error of errors) process.stderr.write(`theme-lint: ${error}\n`);
    process.stderr.write(`theme-lint: ${errors.length} violation(s)\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('theme-lint: clean\n');
  }
}
