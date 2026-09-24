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
 *
 * XChain Explorer - stitching a page together
 *
 * A page request answers with the shared template rather than a file of its own:
 * the chrome components fill their slots, the page's own markup (a list page is
 * composed from layout data rather than stored as a fragment) fills {CONTENT}, and
 * the cross-site switcher fills its own.
 *
 * The three render modules are required here rather than handed in, because no
 * suite replaces them in XChainExplorer.js's require map: they read files under
 * src/ and have no network or database reach to stub out.
 *
 ********************************************************************/

'use strict';

const path = require('path');
const gateRegistry = require('../../consensus/gate_registry.js');
const { renderPlatformSwitcher } = require('../../render/platform_links.js');
const listPage     = require('../../render/list_page.js');
const componentTpl = require('../../render/component_templates.js');

// Inject plain JSON because browser scripts cannot load the Node registry.
// Escape less-than signs so a future string value cannot close the script tag.
function injectAnchorActivation(html) {
    const activation = gateRegistry.copy('anchor_activation.ANCHOR_ACTIVATION');
    const json = JSON.stringify(activation).replace(/</g, '\\u003c');
    return html.replace('{ANCHOR_ACTIVATION}', () => json);
}

/**
 * Render the page this request resolved to into the response.
 */
async function renderPage(explorer, st){
    let cfg = st.cfg;
    // Page handler: stitch the page's own content into the shared template.
    if(cfg.type=='html'){
        let htmlDirectory   = path.join(__dirname, '..', '..', 'content/html/')

        let templateFile    = path.join(htmlDirectory, 'template.html');
        let templateExists  = await explorer.util.fileExists(templateFile);
        let templateContent = (templateExists) ? await explorer.util.fileGetContents(templateFile) : 'Error loading template file!';

        // A list route no longer has a fragment of its own: 76 near-identical
        // pages collapsed onto the shared list-page composition (spec M2.3),
        // which stitches the same markup from content/layouts/list-pages.json.
        // The url table still names the old fragment, so routes and canonical
        // URLs are untouched; only where the markup comes from changed.
        let htmlContent = listPage.render(cfg.file);

        if(htmlContent === null){
            let htmlFile    = path.join(htmlDirectory, cfg.file);
            let htmlExists  = await explorer.util.fileExists(htmlFile);
            htmlContent = (htmlExists) ? await explorer.util.fileGetContents(htmlFile) : 'Error loading html file!';
        }

        // The shell's chrome (nav, search box, theme toggle, footer) is four
        // components now rather than 24KB of inline markup; fill their slots
        // before {CONTENT}, so a component template containing {CONTENT} could
        // never be mistaken for the page's own content slot.
        let pageContent = componentTpl.chrome(templateContent);
        // Layout data a page asks for by name, spliced as a JSON block the
        // page's own script reads back. action.html uses it for the per-type
        // detail-card row configs (spec M2.5): 38 blocks whose row ORDER is
        // now data a theme can resequence, embedded once instead of fetched.
        htmlContent     = listPage.dataBlocks(htmlContent);
        htmlContent     = injectAnchorActivation(htmlContent);
        // Use a replacement FUNCTION, not the raw string: String.replace treats $-sequences
        // ($&, $', $`, $1) specially in a string replacement, so any page content containing
        // them (e.g. a "$" in inline JS or a token description) would be mangled or truncated.
        pageContent     = pageContent.replace('{CONTENT}', () => htmlContent);
        // Cross-site navigation for the *.xchain.io family, rendered from the
        // vendored platform-links.json (see src/render/platform_links.js). Same
        // replacement-function reason as {CONTENT}: $-sequences in the markup
        // must not be treated as capture-group references.
        pageContent     = pageContent.replace('{PLATFORM_SWITCHER}', () => renderPlatformSwitcher());

        st.response.html = pageContent;
    }
}

module.exports = { renderPage, injectAnchorActivation };
