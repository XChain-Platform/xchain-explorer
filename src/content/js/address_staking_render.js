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
 * Derivation and render for the ADDRESS STAKING panel on address.html
 * (/{COIN}/address/{QUERY}), fed by /{COIN}/api/staking/{QUERY}
 * (getAddressStaking, src/db.js).
 *
 * Split out of the page's inline script so a test can drive the real
 * derivation with stubbed responses, the same way validator.html is driven
 * by content-client-validator-detail.test.js.
 *
 * WHY A DERIVATION LAYER AT ALL. The raw tabs further down address.html can
 * already list every one of these rows. What they cannot do is answer the
 * four questions a staker actually has, because each answer is a JUDGEMENT
 * over rows rather than a column:
 *
 *  - WHEN DOES MY COOLDOWN RELEASE. A cooldown row carries an absolute
 *    `cooldown_end_block`, which on its own says nothing: it is a number in
 *    the same units as a height the reader does not have in front of them.
 *    The answer is `cooldown_end_block - chain_tip`, measured in BLOCKS
 *    against the tip served in the SAME response. It is deliberately NOT a
 *    wall-clock estimate: consensus releases the funds on a height, block
 *    intervals vary, and a "~8 hours" that misses by a day is worse than no
 *    figure at all. A matured cooldown and a pending one are therefore two
 *    visibly different states here, never one row with a number in it.
 *
 *  - WHAT IS CLAIMABLE. `claimable` is accrual minus valid claims and the
 *    server deliberately does NOT clamp it at zero, because a negative
 *    remainder is ledger drift (more COLLECTed than ever accrued). Printing
 *    it as a plain figure hides exactly the case worth seeing, so the sign is
 *    read and drift renders as a fault, never as a balance.
 *
 *  - WHAT HAS BEEN SLASHED OUT FROM UNDER ME. The two slash families answer
 *    different questions: capability_slash_events is the bond burn for
 *    equivocating on a consensus capability, slash_events is the contract
 *    stake burn emitted by an EXECUTE. They carry different columns and
 *    different meanings, so they stay as two lists with their own counts, the
 *    same way validator.html keeps them apart. A merged count is true of
 *    neither exposure.
 *
 *  - WHY IS THIS SECTION EMPTY. On any chain other than BTC, `collects`,
 *    `rewards` and `capability_slash_events` are empty BY PROTOCOL, not by
 *    accident: COLLECT is BTC-only (xchain-indexer/src/actions/collect.js),
 *    capability staking is BTC-only (stake.js) and capability slashing is
 *    BTC-only (slash.js). "No rewards yet" would be a false statement to a
 *    DOGE holder, because it implies rewards could appear later on that
 *    chain; so the empty state on a non-BTC chain says the data is BTC-only
 *    instead, in plain chrome rather than a warning colour, because nothing
 *    is wrong.
 *
 * The chain family, not the coin, is what gates that: the indexer's own
 * restriction reads config['COIN'], which is one of BTC / LTC / DOGE for
 * every network (src/config.js sets config['COINS'] = ['BTC','LTC','DOGE']),
 * so regtest RBTC and testnet TBTC are BTC and DO carry this data.
 */

/* -------------------------------------------------------------- derivation */

// Is this page on the BTC chain family (BTC / TBTC / RBTC)? XC.chain is set by
// getXChainParam and is already network-independent; the coin-pattern fallback
// exists only so a page that loaded before XC.chain resolved does not silently
// declare a Bitcoin address "BTC-only, no data here".
function addrStakingIsBtcChain(){
    var chain = (typeof XC !== 'undefined' && XC && XC.chain) ? String(XC.chain).toUpperCase() : '';
    if(chain) return chain === 'BTC';
    var coin = (typeof XC !== 'undefined' && XC && XC.coin) ? String(XC.coin).toUpperCase() : '';
    return /^[TR]?BTC$/.test(coin);
}

// One cooldown row -> its release state, computed HERE from the row's end
// height and the tip in the same response. The server also precomputes
// blocks_remaining/matured, but the page derives its own so the countdown it
// prints and the tip it prints beside it can never disagree, and so a cache or
// proxy that drops those two fields degrades to a number rather than to a lie.
//
// remaining <= 0 is MATURED: the release rule is `tip >= cooldown_end_block`,
// so the block that equals the end height has already released the funds.
function addrStakingCooldownState(row, tip){
    var r   = row || {};
    var raw = r.cooldown_end_block;
    var end = (raw === null || raw === undefined || raw === '') ? NaN : Number(raw);
    var t   = (tip === null || tip === undefined || tip === '')  ? NaN : Number(tip);
    if(isNaN(end) || isNaN(t)){
        // No height to count against is UNKNOWN, and unknown is not matured:
        // telling a staker their funds are released when nothing was measured
        // is the one wrong answer this branch exists to avoid.
        return { key: 'unknown', end_block: isNaN(end) ? null : end, blocks_remaining: null,
                 blocks_since: null, badge: 'text-bg-secondary', label: 'release height unknown' };
    }
    var remaining = end - t;
    if(remaining <= 0)
        return { key: 'matured', end_block: end, blocks_remaining: 0, blocks_since: -remaining,
                 badge: 'text-bg-success', label: 'matured' };
    return { key: 'pending', end_block: end, blocks_remaining: remaining, blocks_since: null,
             badge: 'text-bg-warning text-dark', label: 'cooling down' };
}

// The two cooldown ledgers, kept apart for the same reason the slash families
// are: `unstakes` drains a capability (consensus) stake and `contract_unstakes`
// drains a contract stake. Same shape, different funds.
function addrStakingCooldownFamilies(d){
    var data = d || {};
    var tip  = data.chain_tip;
    var dec  = function(rows){
        return (Array.isArray(rows) ? rows : []).map(function(r){
            return { row: r, state: addrStakingCooldownState(r, tip) };
        });
    };
    return [
        { key: 'contract',   label: 'Contract stake cooldowns (CONTRACT_UNSTAKE)',
          btc_only: false, entries: dec(data.cooldowns) },
        { key: 'capability', label: 'Consensus stake cooldowns (UNSTAKE)',
          btc_only: true,  entries: dec(data.capability_cooldowns) }
    ];
}

// The soonest release still outstanding, for the summary strip. Pending rows
// win over matured ones (a staker with one of each is still waiting), and the
// SMALLEST remaining count is the one that answers "when do I get something".
function addrStakingNextRelease(d){
    var pending = [], matured = 0;
    addrStakingCooldownFamilies(d).forEach(function(f){
        f.entries.forEach(function(e){
            if(e.state.key === 'pending') pending.push(e);
            else if(e.state.key === 'matured') matured++;
        });
    });
    pending.sort(function(a, b){ return a.state.blocks_remaining - b.state.blocks_remaining; });
    return { pending_count: pending.length, matured_count: matured, next: pending.length ? pending[0] : null };
}

function addrStakingPositionFamilies(d){
    var data = d || {};
    return [
        { key: 'contract',   label: 'Contract stake positions (CONTRACT_STAKE)',
          btc_only: false, rows: Array.isArray(data.positions) ? data.positions : [] },
        { key: 'capability', label: 'Consensus stake positions (STAKE)',
          btc_only: true,  rows: Array.isArray(data.capability_positions) ? data.capability_positions : [] }
    ];
}

// Reward accounting. `claimable` is a fixed-8 decimal STRING; drift is read off
// the string's sign rather than by re-doing the subtraction in float, which
// would reintroduce exactly the rounding error the 8dp string type prevents.
function addrStakingRewardSummary(d){
    var data      = d || {};
    var claimable = (data.claimable === null || data.claimable === undefined) ? null : String(data.claimable);
    var drift     = (claimable !== null && claimable.charAt(0) === '-');
    return {
        rewards_total:   data.rewards_total,
        collected_total: data.collected_total,
        claimable:       claimable,
        // Negative remainder = more COLLECTed than accrued. A ledger fault the
        // panel must not hide behind a zero.
        drift:           drift,
        has_claimable:   (claimable !== null && !drift && Number(claimable) > 0),
        rewards:         Array.isArray(data.rewards)  ? data.rewards  : [],
        collects:        Array.isArray(data.collects) ? data.collects : []
    };
}

// BOTH slash families, kept APART and separately counted. Order is fixed so a
// reader's eye learns one layout.
function addrStakingSlashFamilies(d){
    var data = d || {};
    var cap  = Array.isArray(data.capability_slash_events) ? data.capability_slash_events : [];
    var con  = Array.isArray(data.slash_events)            ? data.slash_events            : [];
    return [
        { key: 'capability', rows: cap, count: cap.length, btc_only: true,
          label: 'Consensus equivocation (CAPABILITY_SLASH)',
          blurb: 'Bond burned for equivocating on a capability staked from this address.' },
        { key: 'contract',   rows: con, count: con.length, btc_only: false,
          label: 'Contract stake slashing (SLASH)',
          blurb: 'Stake burned by a contract EXECUTE against a position staked from this address.' }
    ];
}

// Does this address touch staking at ALL? Most addresses do not, so the panel
// is hidden rather than shown empty on those (see address.html). Ledger drift
// counts as activity on its own: a negative claimable with no other rows is
// precisely the case that must never be hidden.
function addrStakingHasActivity(d){
    if(!d) return false;
    var lists = ['positions', 'capability_positions', 'cooldowns', 'capability_cooldowns',
                 'rewards', 'collects', 'capability_slash_events', 'slash_events'];
    for(var i = 0; i < lists.length; i++){
        var v = d[lists[i]];
        if(Array.isArray(v) && v.length) return true;
    }
    if(addrStakingRewardSummary(d).drift) return true;
    var totals = [d.rewards_total, d.collected_total];
    for(var j = 0; j < totals.length; j++){
        if(totals[j] !== null && totals[j] !== undefined && Number(totals[j]) > 0) return true;
    }
    return false;
}

/* ------------------------------------------------------------------ render */

// Page-local escape, matching the pattern the other detail renderers use.
function asEsc(s){ return $('<div>').text(s == null ? '' : String(s)).html(); }

function asBlock(b){
    if(isNull(b)) return '-';
    return formatLink('/' + XC.coin + '/block/' + encodeURIComponent(b), asEsc(numeral(b).format('0,0')));
}

function asAction(i){
    if(isNull(i)) return '-';
    return formatLink('/' + XC.coin + '/action/' + encodeURIComponent(i), asEsc(numeral(i).format('0,0')));
}

function asAddress(a){
    if(isNull(a)) return '-';
    return formatLink('/' + XC.coin + '/address/' + encodeURIComponent(a), formatHash(a, 24));
}

function asAmount(a){
    if(isNull(a)) return '-';
    return '<span class="font-monospace">' + asEsc(formatAmount(a)) + '</span>';
}

function asTime(t){ return isNull(t) ? '-' : formatLivestamp(t); }

function asTable(headers, rowsHtml){
    var html = '<div class="table-responsive"><table class="table table-sm table-borderless mb-0"><tbody><tr>';
    headers.forEach(function(h){ html += '<th class="text-muted fw-normal small">' + asEsc(h) + '</th>'; });
    html += '</tr>' + rowsHtml + '</tbody></table></div>';
    return html;
}

// The one place an empty list is explained. TWO different statements, and
// collapsing them is the defect this function exists to prevent:
//   'none'     - nothing has happened, and something still could
//   'btc-only' - nothing CAN happen, because the action does not exist on this
//                chain. Plain muted chrome, not a warning: no fault occurred.
function asEmpty(kind, text){
    return '<div class="small text-muted addr-staking-empty" data-empty="' + asEsc(kind) + '">'
         + (kind === 'btc-only' ? '<i class="fa fa-circle-info me-1"></i>' : '')
         + asEsc(text) + '</div>';
}

// An empty section on a BTC-only feature: which sentence gets used is decided
// by the CHAIN, never by the row count alone.
function asEmptyForFeature(btcOnly, noneText, btcOnlyText){
    if(btcOnly && !addrStakingIsBtcChain()) return asEmpty('btc-only', btcOnlyText);
    return asEmpty('none', noneText);
}

function asSection(key, title, count, body){
    return '<div class="mb-3 addr-staking-section" data-section="' + asEsc(key) + '">'
         + '<div class="fw-bold small mb-1">' + asEsc(title)
         + ' <span class="badge text-bg-light text-dark addr-staking-count">' + asEsc(count) + '</span></div>'
         + body + '</div>';
}

// Summary strip: the cooldown countdown is the headline, because it is the one
// figure that changes under the reader and the one they came for.
function renderAddressStakingSummary(d){
    var rel   = addrStakingNextRelease(d);
    var rw    = addrStakingRewardSummary(d);
    var open  = addrStakingPositionFamilies(d).reduce(function(a, f){ return a + f.rows.length; }, 0);
    var slash = addrStakingSlashFamilies(d).reduce(function(a, f){ return a + f.count; }, 0);
    var html  = '<div class="row g-2 addr-staking-summary">';

    html += '<div class="col-6 col-lg-3"><div class="small text-muted">Staked positions</div>'
         +  '<div class="fs-5 addr-staking-position-total">' + asEsc(numeral(open).format('0,0')) + '</div></div>';

    // Countdown. Blocks, always; the tip it was measured against is printed
    // beside it so the figure can be checked rather than trusted.
    var cd;
    if(rel.next){
        cd = '<span class="badge ' + rel.next.state.badge + ' addr-staking-countdown" data-cooldown-state="pending">'
           + asEsc(numeral(rel.next.state.blocks_remaining).format('0,0')) + ' block(s) remaining</span>';
    } else if(rel.matured_count){
        cd = '<span class="badge text-bg-success addr-staking-countdown" data-cooldown-state="matured">'
           + asEsc(numeral(rel.matured_count).format('0,0')) + ' matured</span>';
    } else {
        cd = '<span class="text-muted addr-staking-countdown" data-cooldown-state="none">none</span>';
    }
    html += '<div class="col-6 col-lg-3"><div class="small text-muted">Next cooldown release</div>'
         +  '<div class="fs-5">' + cd + '</div>'
         +  '<div class="small text-muted">at chain tip <span class="addr-staking-tip">'
         +  asEsc(isNull(d.chain_tip) ? '-' : numeral(d.chain_tip).format('0,0')) + '</span></div></div>';

    html += '<div class="col-6 col-lg-3"><div class="small text-muted">Claimable rewards</div>'
         +  '<div class="fs-5">' + (rw.drift
                ? '<span class="badge text-bg-danger addr-staking-claimable" data-claimable="drift">'
                  + asEsc(rw.claimable) + '</span>'
                : '<span class="font-monospace addr-staking-claimable" data-claimable="'
                  + (rw.has_claimable ? 'positive' : 'zero') + '">'
                  + asEsc(isNull(rw.claimable) ? '-' : rw.claimable) + '</span>') + '</div>';
    if(rw.drift)
        html += '<div class="small text-muted addr-staking-drift-note">more has been COLLECTed than accrued; '
             +  'this is ledger drift, not a balance</div>';
    html += '</div>';

    html += '<div class="col-6 col-lg-3"><div class="small text-muted">Slash events</div>'
         +  '<div class="fs-5"><span class="badge ' + (slash ? 'text-bg-danger' : 'text-bg-success')
         +  ' addr-staking-slash-total">' + asEsc(numeral(slash).format('0,0')) + '</span></div>'
         +  '<div class="small text-muted">across both slash paths</div></div>';

    html += '</div>';
    return html;
}

// Cooldowns: the centrepiece. Every row prints its own countdown in blocks and
// carries its state as a data attribute, so matured and pending are never the
// same row with a different number in it.
function renderAddressStakingCooldowns(d){
    var families = addrStakingCooldownFamilies(d);
    var html     = '<div class="small text-muted mb-2">Cooldowns release on a BLOCK HEIGHT, so the countdown is '
                 + 'measured in blocks against this chain\'s tip ('
                 + asEsc(isNull(d.chain_tip) ? 'unknown' : numeral(d.chain_tip).format('0,0'))
                 + '), never against wall-clock time.</div>';
    families.forEach(function(f){
        var body = '';
        f.entries.forEach(function(e){
            var r = e.row, s = e.state;
            body += '<tr class="addr-staking-cooldown-row" data-family="' + asEsc(f.key)
                 +  '" data-cooldown-state="' + asEsc(s.key) + '">'
                 +  '<td>' + asAction(r.action_index) + '</td>'
                 +  '<td>' + asAmount(r.amount) + '</td>'
                 +  '<td>' + (isNull(r.tick) ? '<span class="text-muted">-</span>' : asEsc(r.tick)) + '</td>'
                 +  '<td>' + asBlock(s.end_block) + '</td>'
                 +  '<td class="addr-staking-remaining">'
                 +  (s.key === 'pending'
                        ? '<span class="badge ' + s.badge + '">' + asEsc(numeral(s.blocks_remaining).format('0,0')) + ' block(s)</span>'
                        : (s.key === 'matured'
                            ? '<span class="badge ' + s.badge + '">' + asEsc(s.label) + '</span>'
                            : '<span class="badge ' + s.badge + '">' + asEsc(s.label) + '</span>'))
                 +  '</td>'
                 +  '<td>' + asEsc(isNull(r.status) ? '-' : r.status) + '</td>'
                 +  '<td>' + asTime(r.timestamp) + '</td>'
                 +  '</tr>';
        });
        html += asSection('cooldown-' + f.key, f.label, f.entries.length, f.entries.length
            ? asTable(['Action', 'Amount', 'Token', 'Releases At', 'Countdown', 'Status', 'Time'], body)
            : asEmptyForFeature(f.btc_only,
                'No cooldowns on this ledger.',
                'Consensus staking is a Bitcoin-only action, so this address can never have a consensus cooldown on '
                + (typeof XC !== 'undefined' && XC ? XC.coin : 'this chain') + '.'));
    });
    return html;
}

function renderAddressStakingPositions(d){
    var html = '';
    addrStakingPositionFamilies(d).forEach(function(f){
        var body = '';
        f.rows.forEach(function(r){
            var ended = !isNull(r.deactivation_block);
            body += '<tr class="addr-staking-position-row" data-family="' + asEsc(f.key)
                 +  '" data-position-state="' + (ended ? 'ended' : 'active') + '">'
                 +  '<td>' + asAction(r.action_index) + '</td>'
                 +  '<td>' + asAmount(r.amount) + '</td>'
                 +  '<td>' + (isNull(r.tick) ? '<span class="text-muted">-</span>' : asEsc(r.tick)) + '</td>'
                 +  '<td>' + (isNull(r.target_contract_index) ? '<span class="text-muted">-</span>'
                            : formatLink('/' + XC.coin + '/contract/' + encodeURIComponent(r.target_contract_index),
                                         asEsc(r.target_contract_index))) + '</td>'
                 +  '<td>' + asBlock(r.activation_block) + '</td>'
                 +  '<td>' + (ended ? asBlock(r.deactivation_block)
                                    : '<span class="badge text-bg-success">still staked</span>') + '</td>'
                 +  '<td>' + asEsc(isNull(r.status) ? '-' : r.status) + '</td>'
                 +  '<td>' + asTime(r.timestamp) + '</td>'
                 +  '</tr>';
        });
        html += asSection('positions-' + f.key, f.label, f.rows.length, f.rows.length
            ? asTable(['Action', 'Amount', 'Token', 'Contract', 'Activated', 'Deactivated', 'Status', 'Time'], body)
            : asEmptyForFeature(f.btc_only,
                'No positions on this ledger.',
                'Consensus staking (STAKE) is a Bitcoin-only action, so no consensus position can exist for this address on '
                + (typeof XC !== 'undefined' && XC ? XC.coin : 'this chain') + '.'));
    });
    return html;
}

// Accrual, the COLLECT trail that drains it, and what is left. Both halves are
// BTC-only features, so both empty states are chain-aware.
function renderAddressStakingRewards(d){
    var s    = addrStakingRewardSummary(d);
    var html = '<div class="row g-2 mb-2 addr-staking-reward-totals">';
    html += '<div class="col-4"><div class="small text-muted">Accrued</div><div>' + asAmount(s.rewards_total) + '</div></div>';
    html += '<div class="col-4"><div class="small text-muted">COLLECTed</div><div>' + asAmount(s.collected_total) + '</div></div>';
    html += '<div class="col-4"><div class="small text-muted">Claimable</div><div>' + (s.drift
        ? '<span class="badge text-bg-danger addr-staking-claimable-detail" data-claimable="drift">' + asEsc(s.claimable) + '</span>'
        : '<span class="font-monospace addr-staking-claimable-detail" data-claimable="'
          + (s.has_claimable ? 'positive' : 'zero') + '">' + asEsc(isNull(s.claimable) ? '-' : s.claimable)
          + '</span>') + '</div></div>';
    html += '</div>';
    if(s.drift)
        html += '<div class="alert alert-danger py-2 mb-2 small addr-staking-drift-alert">'
             +  'Claimable is NEGATIVE: more has been COLLECTed from this address than the ledger ever accrued to it. '
             +  'This is drift in the reward ledger, not a spendable balance.</div>';

    var rbody = '';
    s.rewards.forEach(function(r){
        rbody += '<tr class="addr-staking-reward-row" data-reward-type="' + asEsc(r.reward_type) + '">'
              +  '<td>' + asEsc(isNull(r.reward_type) ? '-' : r.reward_type) + '</td>'
              +  '<td>' + asEsc(isNull(r.round_reference) ? '-' : r.round_reference) + '</td>'
              +  '<td>' + asAmount(r.amount) + '</td>'
              +  '<td>' + asBlock(r.block_index) + '</td>'
              +  '<td>' + asTime(r.timestamp) + '</td>'
              +  '</tr>';
    });
    html += asSection('rewards', 'Reward accrual', s.rewards.length, s.rewards.length
        ? asTable(['Type', 'Round', 'Amount', 'Block', 'Time'], rbody)
        : asEmptyForFeature(true,
            'No rewards accrued.',
            'Staking rewards accrue only on the Bitcoin chain, so no reward can be recorded for this address on '
            + (typeof XC !== 'undefined' && XC ? XC.coin : 'this chain') + '.'));

    var cbody = '';
    s.collects.forEach(function(r){
        cbody += '<tr class="addr-staking-collect-row">'
              +  '<td>' + asAction(r.action_index) + '</td>'
              +  '<td>' + asAmount(r.amount) + '</td>'
              +  '<td>' + asBlock(r.block_index) + '</td>'
              +  '<td>' + asEsc(isNull(r.status) ? '-' : r.status) + '</td>'
              +  '<td>' + asTime(r.timestamp) + '</td>'
              +  '</tr>';
    });
    html += asSection('collects', 'Recent COLLECT claims', s.collects.length, s.collects.length
        ? asTable(['Action', 'Amount', 'Block', 'Status', 'Time'], cbody)
        : asEmptyForFeature(true,
            'No COLLECT claims.',
            'COLLECT is a Bitcoin-only action, so this address cannot have COLLECT claims on '
            + (typeof XC !== 'undefined' && XC ? XC.coin : 'this chain') + '.'));
    return html;
}

// BOTH slash families, side by side and never merged.
function renderAddressStakingSlashes(d){
    var families = addrStakingSlashFamilies(d);
    var total    = families.reduce(function(a, f){ return a + f.count; }, 0);
    var html     = '';
    if(total === 0)
        html += '<div class="mb-2"><span class="badge text-bg-success addr-staking-slash-clean">'
             +  'no slash events on either path</span></div>';
    // Slash exposure reaches an address through the KEYS it staked with, not
    // through the address itself; saying so stops a zero here from being read
    // as "this address holds no risk".
    html += '<div class="small text-muted mb-2">Slash exposure is matched through the signing pubkeys staked from '
         +  'this address, because neither slash ledger records an address.</div>';
    families.forEach(function(f){
        html += '<div class="mb-3 addr-staking-slash-family" data-family="' + asEsc(f.key) + '">';
        html += '<div class="fw-bold small mb-1">' + asEsc(f.label)
             +  ' <span class="badge ' + (f.count ? 'text-bg-danger' : 'text-bg-light text-dark')
             +  ' addr-staking-slash-count">' + asEsc(f.count) + '</span></div>';
        html += '<div class="small text-muted mb-1">' + asEsc(f.blurb) + '</div>';
        if(!f.count){
            html += asEmptyForFeature(f.btc_only,
                'None recorded.',
                'Capability slashing is a Bitcoin-only action, so this family cannot record an event on '
                + (typeof XC !== 'undefined' && XC ? XC.coin : 'this chain') + '.');
            html += '</div>';
            return;
        }
        var body = '';
        if(f.key === 'capability'){
            f.rows.forEach(function(r){
                body += '<tr class="addr-staking-slash-row" data-family="capability">'
                     +  '<td>' + asAction(r.slash_action_index) + '</td>'
                     +  '<td><span class="badge text-bg-info">' + asEsc(isNull(r.capability) ? '-' : r.capability) + '</span></td>'
                     +  '<td class="font-monospace small">' + formatHash(r.slashed_pubkey, 20) + '</td>'
                     +  '<td class="font-monospace small">' + formatHash(r.equiv_key, 20) + '</td>'
                     +  '<td>' + asAmount(r.amount) + '</td>'
                     +  '<td>' + asAmount(r.bounty_amount) + '</td>'
                     +  '<td>' + asAmount(r.treasury_amount) + '</td>'
                     +  '<td>' + asBlock(r.block_index) + '</td>'
                     +  '<td>' + asTime(r.timestamp) + '</td>'
                     +  '</tr>';
            });
            html += asTable(['SLASH Action', 'Capability', 'Slashed Key', 'Equivocation Key', 'Amount',
                             'Bounty', 'Treasury', 'Block', 'Time'], body);
        } else {
            f.rows.forEach(function(r){
                body += '<tr class="addr-staking-slash-row" data-family="contract">'
                     +  '<td>' + asAction(r.execution_index) + '</td>'
                     +  '<td>' + (isNull(r.target_contract_index) ? '-' :
                                  formatLink('/' + XC.coin + '/contract/' + encodeURIComponent(r.target_contract_index),
                                             asEsc(r.target_contract_index))) + '</td>'
                     +  '<td class="font-monospace small">' + formatHash(r.slashed_pubkey, 20) + '</td>'
                     +  '<td>' + asEsc(isNull(r.tick) ? '-' : r.tick) + '</td>'
                     +  '<td>' + asAmount(r.amount) + '</td>'
                     +  '<td>' + asAddress(r.destination) + '</td>'
                     +  '<td>' + asBlock(r.block_index) + '</td>'
                     +  '<td>' + asTime(r.timestamp) + '</td>'
                     +  '</tr>';
            });
            html += asTable(['EXECUTE Action', 'Contract', 'Slashed Key', 'Token', 'Amount',
                             'Destination', 'Block', 'Time'], body);
        }
        html += '</div>';
    });
    return html;
}
