'use strict';

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
 * Platform switcher: cross-site navigation for the *.xchain.io family.
 *
 * The explorer is one surface of a platform whose other surfaces (wallet,
 * docs, bootstraps, the validator hub) live on sibling hosts. Before this
 * existed there was no way to get sideways from here to any of them.
 *
 * THE LIST IS NOT MAINTAINED HERE. It is generated in xchain-websites from
 * PLATFORM_LINKS and published at https://xchain.io/assets/platform-links.json;
 * content/json/platform-links.json is a VENDORED COPY. Do not hand-edit it to
 * add a host: change it in xchain-websites, rebuild there, and re-vendor. That
 * repo's CI cannot see this one, hence the vendored copy plus the drift test
 * in test/smoke/connected/platform-links-drift.test.js, which fetches the
 * published URL and compares.
 *
 * Hand-copying a list between repos without that test is how xchain-websites
 * ended up with four stylesheets that silently disagreed.
 **********************************************************************/

const LINKS = require('./content/json/platform-links.json');

// This host's key, so its own entry renders as a marked, non-clickable row.
const CURRENT = 'explorer';

const esc = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * Bootstrap 5 navbar dropdown for the platform switcher, matching the
 * surrounding navbar markup in content/html/template.html.
 *
 * @param {{links: Array}} [list] link list to render; defaults to the vendored
 *        file. Injectable so the escaping can be tested against hostile values.
 * @returns {string} markup for one <li class="nav-item dropdown">
 */
function renderPlatformSwitcher(list = LINKS) {
    const rows = list.links.map((p) => {
        const label = esc(p.label);
        const icon  = `<i class="${esc(p.icon)} fa-fw me-2"></i>`;
        if (p.key === CURRENT) {
            return `<li><span class="dropdown-item disabled d-flex align-items-center" aria-current="page">`
                 + `${icon}${label}<small class="ms-auto ps-3 text-body-secondary">you are here</small></span></li>`;
        }
        return `<li><a class="dropdown-item" href="${esc(p.href)}" title="${label}">${icon}${label}</a></li>`;
    }).join('\n                            ');

    return `<li class="nav-item dropdown">
                        <a class="nav-link" href="#" data-bs-toggle="dropdown" aria-expanded="false" title="XChain platform sites" aria-label="XChain platform sites"><i class="fa fa-2x fa-grid-2"></i></a>
                        <ul class="dropdown-menu dropdown-menu-end mt-0">
                            ${rows}
                        </ul>
                    </li>`;
}

module.exports = { LINKS, CURRENT, renderPlatformSwitcher };
