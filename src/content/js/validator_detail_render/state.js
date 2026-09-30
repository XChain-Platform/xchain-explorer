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

// Per-state chrome. Colour comes from Bootstrap's contextual classes (which
// follow data-bs-theme) rather than any literal, so the theme layer owns it.
var VALIDATOR_CAPABILITY_STATES = {
    active:        { badge: 'text-bg-success',           label: 'active',            icon: 'fa-circle-check'         },
    self_test_bad: { badge: 'text-bg-danger',            label: 'self-test failed',  icon: 'fa-circle-xmark'         },
    untested:      { badge: 'text-bg-warning text-dark', label: 'self-test unknown', icon: 'fa-circle-question'      },
    disabled:      { badge: 'text-bg-secondary',         label: 'disabled',          icon: 'fa-circle-minus'         },
    not_qualified: { badge: 'text-bg-light text-dark',   label: 'not qualified',     icon: 'fa-circle-minus'         }
};

var VALIDATOR_STATUS_STATES = {
    active:      { badge: 'text-bg-success',           label: 'active'      },
    deactivated: { badge: 'text-bg-secondary',         label: 'deactivated' },
    inactive:    { badge: 'text-bg-warning text-dark', label: 'no active stake' }
};

// Tri-state read of a hub flag. The co-located schema serves tinyint 0/1 and the
// hub JSON-RPC serves real booleans, so both are accepted; NULL/absent stays
// NULL, because "the self-test never reported" is not "the self-test failed".
function validatorFlag(v){
    if(v === null || v === undefined || v === '') return null;
    if(v === true  || v === 1 || v === '1' || v === 'true')  return true;
    if(v === false || v === 0 || v === '0' || v === 'false') return false;
    return Boolean(v);
}

// One capability row -> one state. RANK, worst-first, and the order is the whole
// point: an unqualified row's self-test result is meaningless (it is not in the
// electorate), a failing self-test outranks a disabled flag because the operator
// disabling a broken capability does not make it healthy, and only a row that
// clears all three reads as active.
function validatorCapabilityState(row){
    var r = row || {};
    var qualified = validatorFlag(r.qualified);
    var selfTest  = validatorFlag(r.self_test_ok);
    var enabled   = validatorFlag(r.enabled);
    var key;
    if(qualified !== true)      key = 'not_qualified';
    else if(selfTest === false) key = 'self_test_bad';
    else if(selfTest === null)  key = 'untested';
    else if(enabled === false)  key = 'disabled';
    else                        key = 'active';
    var chrome = VALIDATOR_CAPABILITY_STATES[key];
    return {
        key:        key,
        badge:      chrome.badge,
        label:      chrome.label,
        icon:       chrome.icon,
        capability: r.capability,
        qualified:  qualified,
        self_test_ok: selfTest,
        enabled:    enabled,
        qualified_at_block: r.qualified_at_block,
        updated_at: r.updated_at
    };
}

// The hub federation registry decorates the on-chain identity; it never gates it.
// THREE outcomes, and collapsing any two of them lies to the reader:
//   unknown      - registry_known:false, no registry was reachable
//   registered   - a registry entry exists for this signing pubkey
//   unregistered - a registry WAS read and this pubkey is not in it
function validatorRegistryState(d){
    var data  = d || {};
    var entry = data.registry || null;
    if(data.registry_known !== true)
        return { key: 'unknown', known: false, registered: false, entry: null,
                 badge: 'text-bg-warning text-dark', label: 'registry unavailable' };
    if(!entry)
        return { key: 'unregistered', known: true, registered: false, entry: null,
                 badge: 'text-bg-secondary', label: 'not in hub registry' };
    return { key: 'registered', known: true, registered: true, entry: entry,
             badge: 'text-bg-info', label: (entry.status ? String(entry.status) : 'registered') };
}

// Identity status. position_count is the count of stake rows still carrying a
// NULL deactivation_block, so it, not the amount, is what "still staked" means:
// a validator can hold positions worth zero and still be in the electorate.
function validatorStatusState(d){
    var data = d || {};
    var key;
    if(Number(data.position_count) > 0)                          key = 'active';
    else if(data.deactivation_block !== null &&
            data.deactivation_block !== undefined)               key = 'deactivated';
    else                                                         key = 'inactive';
    var chrome = VALIDATOR_STATUS_STATES[key];
    return { key: key, badge: chrome.badge, label: chrome.label };
}

// One stakes[] row -> its lifecycle state. A rejected STAKE is not a stake that
// ended, so consensus status is read BEFORE the deactivation height.
function validatorStakeRowState(row){
    var r = row || {};
    var status = (r.status === null || r.status === undefined) ? '' : String(r.status).trim().toLowerCase();
    if(status && status !== 'valid')
        return { key: 'rejected', badge: 'text-bg-danger', label: status };
    if(r.deactivation_block !== null && r.deactivation_block !== undefined)
        return { key: 'ended', badge: 'text-bg-secondary', label: 'ended' };
    return { key: 'active', badge: 'text-bg-success', label: 'active' };
}

// Reward accounting. `claimable` is a fixed-8 decimal STRING from the server
// (accrual minus valid claims, UNCLAMPED). Drift is detected on the string's
// sign rather than by re-doing the subtraction in float, which would introduce
// exactly the rounding error the 8dp string type exists to avoid.
function validatorRewardSummary(d){
    var data      = d || {};
    var claimable = (data.claimable === null || data.claimable === undefined) ? null : String(data.claimable);
    var drift     = (claimable !== null && claimable.charAt(0) === '-');
    var hasClaim  = (claimable !== null && !drift && Number(claimable) > 0);
    return {
        rewards_total:   data.rewards_total,
        collected_total: data.collected_total,
        claimable:       claimable,
        // Negative remainder = more COLLECTed than accrued, which is a ledger
        // fault the page must not hide behind a zero.
        drift:           drift,
        has_claimable:   hasClaim,
        collects:        Array.isArray(data.collects) ? data.collects : []
    };
}

// The two slash families, kept APART. Same order every render so a reader's eye
// learns one layout; each family carries its own count because a combined count
// describes neither exposure.
function validatorSlashFamilies(d){
    var data = d || {};
    var cap  = Array.isArray(data.capability_slash_events) ? data.capability_slash_events : [];
    var con  = Array.isArray(data.slash_events)            ? data.slash_events            : [];
    return [
        { key: 'capability', rows: cap, count: cap.length,
          label: 'Consensus equivocation (CAPABILITY_SLASH)',
          blurb: 'Bond burned for equivocating on a capability this validator held.' },
        { key: 'contract',   rows: con, count: con.length,
          label: 'Contract stake slashing (SLASH)',
          blurb: 'Stake burned by a contract EXECUTE against this validator\'s staked position.' }
    ];
}

// Per-provider ATTEST accountability. quality_score is the hub's own figure and
// is shown as served; the fulfilled/attempted ratio is derived alongside it so a
// score is never the only number on screen (a score with no volume behind it
// says nothing). slashed_count is NOT folded into attempts: a slash is an
// outcome of a fulfilled-but-wrong response, not a separate request.
function validatorAttestationSummary(rows){
    return (Array.isArray(rows) ? rows : []).map(function(r){
        var fulfilled = Number(r.fulfilled_count || 0);
        var missed    = Number(r.missed_count    || 0);
        var attempts  = fulfilled + missed;
        return {
            id:                 r.id,
            provider_id:        r.provider_id,
            fulfilled_count:    fulfilled,
            missed_count:       missed,
            slashed_count:      Number(r.slashed_count || 0),
            quality_score:      r.quality_score,
            last_updated_block: r.last_updated_block,
            attempts:           attempts,
            // NULL, not 0: no attempts means no rate exists, and a 0% rate would
            // read as a validator that missed everything.
            fulfilled_rate:     (attempts > 0) ? (fulfilled / attempts) : null
        };
    });
}

// Page-local escape, matching the pattern the other detail renderers use.
function vdEsc(s){ return $('<div>').text(s == null ? '' : String(s)).html(); }

function vdRow(label, value){
    return '<tr><th class="text-muted fw-normal vd-label">' + vdEsc(label) + '</th><td>' + value + '</td></tr>';
}

function vdBlock(b){
    if(isNull(b)) return '-';
    return formatLink('/' + XC.coin + '/block/' + encodeURIComponent(b), numeral(b).format('0,0'));
}

function vdAction(i){
    if(isNull(i)) return '-';
    return formatLink('/' + XC.coin + '/action/' + encodeURIComponent(i), numeral(i).format('0,0'));
}

function vdAddress(a){
    if(isNull(a)) return '-';
    return formatLinkHtml('/' + XC.coin + '/address/' + encodeURIComponent(a), formatHash(a, 24));
}

function vdAmount(a){
    if(isNull(a)) return '-';
    return '<span class="font-monospace">' + vdEsc(formatAmount(a)) + '</span>';
}

function vdTime(t){
    return isNull(t) ? '-' : formatLivestamp(t);
}

function vdEmpty(text){
    return '<div class="text-muted small vd-empty">' + vdEsc(text) + '</div>';
}

// A titled sub-list. Every history block on this page is one of these, so the
// sections stay visually parallel and a new one cannot invent its own chrome.
function vdSection(title, count, body){
    var html = '<div class="mb-3 vd-section">';
    html += '<div class="fw-bold small mb-1">' + vdEsc(title)
         +  ' <span class="badge text-bg-light text-dark vd-count">' + vdEsc(count) + '</span></div>';
    html += body;
    html += '</div>';
    return html;
}

function vdTable(headers, rowsHtml){
    var html = '<div class="table-responsive"><table class="table table-sm table-borderless mb-0"><thead><tr>';
    headers.forEach(function(h){ html += '<th class="text-muted fw-normal small">' + vdEsc(h) + '</th>'; });
    html += '</tr></thead><tbody>' + rowsHtml + '</tbody></table></div>';
    return html;
}

// yes / no / unknown. The third state is the one that matters: a NULL self-test
// rendered as "No" accuses an operator of running a broken node.
function vdFlagBadge(v){
    if(v === null) return '<span class="badge text-bg-warning text-dark vd-flag" data-flag="unknown">unknown</span>';
    return v ? '<span class="badge text-bg-success vd-flag" data-flag="yes">yes</span>'
             : '<span class="badge text-bg-secondary vd-flag" data-flag="no">no</span>';
}
