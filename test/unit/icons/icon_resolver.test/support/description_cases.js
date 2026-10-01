'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// [description, expected_scheme, substring_or_null_for_url_or_data]
// One row per description the resolver must classify.
const cases = [
    ['stamp:iVBORw0KGgo=',                                                                  'stamp',        'iVBORw0KGgo='],
    ['stamp:!!!not-base-64!!!',                                                             null,           null],   // invalid base64 -> null (no retries)
    ['stamp:',                                                                              null,           null],   // empty stub -> null
    ['ord:1d36aa544a20be86dca452e3abe464d33dd8567392dee8e333f72519e97af679',                'ord',          'tx=1d36aa544a20be'],
    ['ord:HTaqVEogvobcpFLjq+Rk0z3YVnOS3ujjM/clGel69nk=',                                    'ord',          'tx=1d36aa544a20be'],
    ['ipfs:QmdnznjxzrjmLGpwjiDrgfdAu5r7VB4tWWWVtNRtqYqACq',                                 'ipfs',         'ipfsc.crystalsuite.com/Qmdn'],
    ['ipfs://QmdnznjxzrjmLGpwjiDrgfdAu5r7VB4tWWWVtNRtqYqACq',                               'ipfs',         'ipfsc.crystalsuite.com/Qmdn'],
    ['ar:jGxVm7yghVDfv39tJds8kRFFrIsGTsg3h-JgXHx_inw',                                      'arweave',      'arweave.net/jGxVm7'],
    ['AR:jGxVm7yghVDfv39tJds8kRFFrIsGTsg3h-JgXHx_inw',                                      'arweave',      'arweave.net/jGxVm7'],
    ['imgur/yTS3gEv.png',                                                                   'imgur',        'i.imgur.com/yTS3gEv.png'],
    ['imgur/yTS3gEv.png;XChain',                                                            'imgur',        'i.imgur.com/yTS3gEv.png'],
    ['imgur.com/yTS3gEv.png',                                                               'imgur',        'i.imgur.com/yTS3gEv.png'],
    ['imgur.com/a/tf7ZeBG.jpg',                                                             'imgur',        'i.imgur.com/tf7ZeBG.jpg'],
    ['imgur.com/gallery/2XaB4Kg',                                                           'imgur',        'i.imgur.com/2XaB4Kg'],
    ['https://imgur.com/2XaB4Kg',                                                           'imgur',        'i.imgur.com/2XaB4Kg'],
    ['https://imgur.com/gallery/2XaB4Kg',                                                   'imgur',        'i.imgur.com/2XaB4Kg'],
    ['https://imgur.com/a/tf7ZeBG',                                                         'imgur',        'i.imgur.com/tf7ZeBG'],
    ['http://imgur.com/cuiDGeH.jpg',                                                        'imgur',        'i.imgur.com/cuiDGeH.jpg'],
    // Direct i.imgur.com URLs must still fall through to image_url, NOT match imgur:
    ['https://i.imgur.com/yTS3gEv.png',                                                     'image_url',    'yTS3gEv.png'],
    ['youtube/FenVJ_cyE5M;Title',                                                           null,           null],
    ['soundcloud/924613324;Track',                                                          null,           null],
    ['https://arweave.net/jGxVm7yghVDfv39tJds8kRFFrIsGTsg3h-JgXHx_inw',                     'arweave_url',  'arweave.net/jGxVm7yghVDfv39'],
    ['https://arweave.net/jGxVm7yghVDfv39tJds8kRFFrIsGTsg3h-JgXHx_inw/x.json',              'arweave_url',  'arweave.net/jGxVm7yghVDfv39'],
    ['https://j-dog.net/json/JDOG.json',                                                    'json_url',     'JDOG.json'],
    ['https://j-dog.net/json/JDOG.json;abc123sha',                                          'json_url',     'JDOG.json'],
    ['https://i.imgur.com/yTS3gEv.png',                                                     'image_url',    'yTS3gEv.png'],
    ['https://example.com/foo.GIF?t=1',                                                     'image_url',    'foo.GIF'],
    // SVG is refused by the image store, so a bare .svg resolves to no icon source.
    ['https://example.com/logo.svg',                                                        null,           null],
    ['https://example.com/logo.SVG?v=2;Title',                                              null,           null],
    ['',                                                                                    null,           null],
    ['just some random text',                                                               null,           null],
    [null,                                                                                  null,           null],
    ['https://arweave.net/abc/x.json',                                                      'arweave_url',  'arweave.net/abc'],
    // The json lane is https on both sides of the mirror (see the exact-URL block below).
    ['example.com/meta.json',                                                               'json_url',     'https://example.com/meta.json'],
    ['http://example.com/meta.json',                                                        'json_url',     'https://example.com/meta.json'],
];

module.exports = { cases };
