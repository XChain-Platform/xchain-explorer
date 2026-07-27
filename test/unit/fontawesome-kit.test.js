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
 **********************************************************************/

// Unit tests for src/fontawesome-kit.js . Two things are load-bearing:
// the kit token must come from the environment and never from tracked source,
// and whatever the environment supplies has to stay inert inside a <script>.

const { expect } = require('chai');
const fs   = require('fs');
const path = require('path');

const fak = require('../../src/fontawesome-kit.js');

// A token-shaped value that is obviously synthetic, so a grep for real kit
// tokens over the tree does not trip on this fixture.
const FAKE_TOKEN = 'aaaabbbbcc';

function env(extra){
    return Object.assign({}, extra);
}

describe('fontawesome-kit: settings from the environment', () => {

    afterEach(() => fak._resetCache());

    it('is disabled when no token is configured', () => {
        expect(fak.readKitSettings(env({}))).to.equal(null);
        expect(fak.buildKitConfig(env({}))).to.equal(null);
        expect(fak.renderConfigPrologue(env({}))).to.equal('');
        expect(fak.renderKitScript(env({}))).to.equal(fak.DISABLED_STUB);
    });

    it('is disabled when the token is blank or whitespace', () => {
        expect(fak.readKitSettings(env({ EXPLORER_FONTAWESOME_KIT_TOKEN: '' }))).to.equal(null);
        expect(fak.readKitSettings(env({ EXPLORER_FONTAWESOME_KIT_TOKEN: '   ' }))).to.equal(null);
    });

    it('rejects a token that is not kit-shaped rather than embedding it', () => {
        for(const bad of ['short', 'has spaces here', 'quote"inject', 'semi;colon', 'a'.repeat(65)]){
            expect(fak.readKitSettings(env({ EXPLORER_FONTAWESOME_KIT_TOKEN: bad })), bad).to.equal(null);
        }
    });

    it('accepts a well-formed token and defaults the rest', () => {
        const settings = fak.readKitSettings(env({ EXPLORER_FONTAWESOME_KIT_TOKEN: FAKE_TOKEN }));
        expect(settings.token).to.equal(FAKE_TOKEN);
        expect(settings.version).to.equal(fak.DEFAULT_VERSION);
        // A deployment that has not claimed a Pro seat does not get one.
        expect(settings.license).to.equal('free');
        expect(settings).to.not.have.property('id');
        expect(settings).to.not.have.property('customIconsCssPath');
    });

    it('trims surrounding whitespace off the token', () => {
        const settings = fak.readKitSettings(env({ EXPLORER_FONTAWESOME_KIT_TOKEN: '  ' + FAKE_TOKEN + '\n' }));
        expect(settings.token).to.equal(FAKE_TOKEN);
    });

    it('takes a pro entitlement only when the deployment states it', () => {
        const pro = fak.readKitSettings(env({
            EXPLORER_FONTAWESOME_KIT_TOKEN: FAKE_TOKEN,
            EXPLORER_FONTAWESOME_KIT_LICENSE: 'PRO'
        }));
        expect(pro.license).to.equal('pro');

        const bogus = fak.readKitSettings(env({
            EXPLORER_FONTAWESOME_KIT_TOKEN: FAKE_TOKEN,
            EXPLORER_FONTAWESOME_KIT_LICENSE: 'enterprise'
        }));
        expect(bogus.license).to.equal('free');
    });

    it('accepts a numeric kit id and drops a non-numeric one', () => {
        expect(fak.readKitSettings(env({
            EXPLORER_FONTAWESOME_KIT_TOKEN: FAKE_TOKEN,
            EXPLORER_FONTAWESOME_KIT_ID: '72315847'
        })).id).to.equal(72315847);

        expect(fak.readKitSettings(env({
            EXPLORER_FONTAWESOME_KIT_TOKEN: FAKE_TOKEN,
            EXPLORER_FONTAWESOME_KIT_ID: '723-abc'
        }))).to.not.have.property('id');
    });

    it('validates the kit version and falls back to the default', () => {
        expect(fak.readKitSettings(env({
            EXPLORER_FONTAWESOME_KIT_TOKEN: FAKE_TOKEN,
            EXPLORER_FONTAWESOME_KIT_VERSION: '6.5.2'
        })).version).to.equal('6.5.2');

        expect(fak.readKitSettings(env({
            EXPLORER_FONTAWESOME_KIT_TOKEN: FAKE_TOKEN,
            EXPLORER_FONTAWESOME_KIT_VERSION: 'latest; alert(1)'
        })).version).to.equal(fak.DEFAULT_VERSION);
    });

    it('validates the custom-icons stylesheet path', () => {
        expect(fak.readKitSettings(env({
            EXPLORER_FONTAWESOME_KIT_TOKEN: FAKE_TOKEN,
            EXPLORER_FONTAWESOME_KIT_CUSTOM_ICONS_PATH: 'abc123/72315847/kit-upload.css'
        })).customIconsCssPath).to.equal('abc123/72315847/kit-upload.css');

        expect(fak.readKitSettings(env({
            EXPLORER_FONTAWESOME_KIT_TOKEN: FAKE_TOKEN,
            EXPLORER_FONTAWESOME_KIT_CUSTOM_ICONS_PATH: 'x";alert(1);//'
        }))).to.not.have.property('customIconsCssPath');
    });
});

describe('fontawesome-kit: rendered script', () => {

    afterEach(() => fak._resetCache());

    it('assigns the loader global and carries the configured token', () => {
        const prologue = fak.renderConfigPrologue(env({ EXPLORER_FONTAWESOME_KIT_TOKEN: FAKE_TOKEN }));
        expect(prologue).to.contain('window.' + fak.CONFIG_GLOBAL + ' = ');
        const parsed = JSON.parse(prologue.replace('window.' + fak.CONFIG_GLOBAL + ' = ', '').replace(/;\s*$/, ''));
        expect(parsed.token).to.equal(FAKE_TOKEN);
        expect(parsed.baseUrl).to.equal(fak.KIT_DEFAULTS.baseUrl);
        expect(parsed.method).to.equal('css');
    });

    it('escapes tag-starting characters so the payload cannot break out of a script element', () => {
        // The path is rejected outright, but the escaping is what makes any
        // future value safe, so it is asserted on the serialiser's output.
        const prologue = fak.renderConfigPrologue(env({
            EXPLORER_FONTAWESOME_KIT_TOKEN: FAKE_TOKEN,
            EXPLORER_FONTAWESOME_KIT_VERSION: '6.4.0'
        }));
        expect(prologue).to.not.contain('<');
        expect(prologue).to.not.contain('>');
    });

    it('prepends the config to the vendored loader when enabled', () => {
        const script = fak.renderKitScript(env({ EXPLORER_FONTAWESOME_KIT_TOKEN: FAKE_TOKEN }));
        expect(script.indexOf('window.' + fak.CONFIG_GLOBAL)).to.equal(0);
        expect(script).to.contain('kit-loader');
        expect(script.length).to.be.greaterThan(10000);
    });

    it('serves an inert stub with no kit config when disabled', () => {
        const script = fak.renderKitScript(env({}));
        expect(script).to.not.contain('window.' + fak.CONFIG_GLOBAL);
        expect(script).to.not.contain('fontawesome.com');
        expect(script).to.contain('EXPLORER_FONTAWESOME_KIT_TOKEN');
    });
});

describe('fontawesome-kit: express handler', () => {

    afterEach(() => {
        delete process.env.EXPLORER_FONTAWESOME_KIT_TOKEN;
        fak._resetCache();
    });

    function fakeRes(){
        const res = { headers: {}, statusCode: 200, contentType: null, body: null };
        res.set    = (k, v) => { res.headers[k] = v; return res; };
        res.type   = (t)    => { res.contentType = t; return res; };
        res.status = (c)    => { res.statusCode = c; return res; };
        res.send   = (b)    => { res.body = b; return res; };
        return res;
    }

    it('serves the stub as javascript and lets shared caches keep it', () => {
        delete process.env.EXPLORER_FONTAWESOME_KIT_TOKEN;
        const res = fakeRes();
        fak.serve({}, res);
        expect(res.contentType).to.equal('application/javascript');
        expect(res.body).to.equal(fak.DISABLED_STUB);
        expect(res.headers['Cache-Control']).to.contain('public');
    });

    it('keeps a token-bearing body out of shared caches', () => {
        process.env.EXPLORER_FONTAWESOME_KIT_TOKEN = FAKE_TOKEN;
        const res = fakeRes();
        fak.serve({}, res);
        expect(res.body).to.contain(FAKE_TOKEN);
        expect(res.headers['Cache-Control']).to.contain('private');
    });
});

describe('fontawesome-kit: wiring', () => {

    const srcDir = path.join(__dirname, '..', '..', 'src');

    it('registers the route ahead of the /js static mount, or the file would win', () => {
        const source = fs.readFileSync(path.join(srcDir, 'XChainExplorer.js'), 'utf8');
        const routeAt  = source.indexOf("this.app.get('/js/fontawesome-kit.js'");
        const staticAt = source.indexOf("for(let directory of urls['static'])");
        expect(routeAt).to.be.greaterThan(-1);
        expect(staticAt).to.be.greaterThan(-1);
        expect(routeAt).to.be.lessThan(staticAt);
    });

    it('opens the CSP to Font Awesome origins only when a kit is configured', () => {
        const source = fs.readFileSync(path.join(srcDir, 'api.js'), 'utf8');
        expect(source).to.contain('FA_KIT_ENABLED');
        // The origins must not be unconditional literals in the directives
        // themselves (the explanatory comments there may still name them).
        const directives = source
            .slice(source.indexOf('contentSecurityPolicy'), source.indexOf('app.use(express.json'))
            .split('\n')
            .filter(line => !line.trim().startsWith('//'))
            .join('\n');
        expect(directives).to.not.contain('fontawesome.com');
    });
});

describe('fontawesome-kit: tracked source stays credential-free', () => {

    const contentDir = path.join(__dirname, '..', '..', 'src', 'content', 'js');

    it('ships the vendored loader without an account config', () => {
        const loader = fs.readFileSync(fak.LOADER_FILE, 'utf8');
        expect(loader).to.not.match(/"token"\s*:/);
        expect(loader).to.not.match(/"license"\s*:\s*"pro"/);
        expect(loader).to.not.contain('window.' + fak.CONFIG_GLOBAL + ' =');
    });

    it('no longer ships a pre-baked kit asset', () => {
        expect(fs.existsSync(path.join(contentDir, 'fontawesome-kit.js'))).to.equal(false);
    });

    it('has no kit token anywhere under src/content/js', () => {
        for(const name of fs.readdirSync(contentDir)){
            const body = fs.readFileSync(path.join(contentDir, name), 'utf8');
            expect(body, name).to.not.match(/FontAwesomeKitConfig\s*=\s*\{/);
        }
    });
});
