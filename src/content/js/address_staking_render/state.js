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
