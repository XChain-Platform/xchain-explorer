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
 * Derivation and render for validator.html (/{COIN}/validator/{QUERY}).
 *
 * Split out of the page's inline script so a test can drive the real
 * derivation with stubbed /api/validator responses, the same way
 * xcall_timeline_render.js is driven by content-client-xcall-timeline.test.js.
 *
 * WHY A DERIVATION LAYER AT ALL. Everything a reader needs to judge a
 * validator is a JUDGEMENT over several rows, never a column:
 *
 *  - A capability is not a boolean. `qualified`, `self_test_ok` and `enabled`
 *    are three independent flags, and the interesting states are the
 *    disagreements between them: qualified-but-failing-self-test is an
 *    operator problem, qualified-but-disabled is an operator CHOICE, and a
 *    NULL self_test_ok is a self-test that never reported. Rendering three
 *    yes/no badges leaves the reader to combine them, and they combine
 *    differently than the obvious reading (see validatorCapabilityState).
 *
 *  - `registry_known:false` means the hub registry could not be consulted at
 *    all. That is UNKNOWN, not "unregistered" and emphatically not "has no
 *    capabilities": the two render as visibly different states here, because
 *    an outage drawn as an empty result is a false claim about consensus.
 *
 *  - The two slash families answer different questions. capability_slash_events
 *    is the equivocation bond-burn against a CONSENSUS validator;
 *    slash_events is the contract-stake burn emitted by an EXECUTE. They carry
 *    different columns and different meanings, so they are kept as two lists
 *    with their own counts; merging them produces a number that is true of
 *    nothing.
 *
 *  - `claimable` is accrual minus claims and the server deliberately does NOT
 *    clamp it at zero, because a negative remainder is ledger drift. A page
 *    that prints it as a plain figure hides exactly the case worth seeing.
 */


/* ------------------------------------------------------------------ render */


// Identity spine: who this is, and the STAKE action that established it.
function renderValidatorIdentity(d){
    var status = validatorStatusState(d);
    var reg    = validatorRegistryState(d);
    var html   = '';
    html += vdRow('Status', '<span class="badge ' + status.badge + ' vd-status" data-status="' + vdEsc(status.key) + '">'
                + vdEsc(status.label) + '</span>');
    html += vdRow('Signing Pubkey', isNull(d.signing_pubkey) ? '-'
                : '<span class="font-monospace small">' + vdEsc(d.signing_pubkey) + '</span>');
    html += vdRow('Staking Address', vdAddress(d.source));
    html += vdRow('Chains', (reg.entry && reg.entry.chains)
                ? '<span class="vd-chains">' + vdEsc(reg.entry.chains) + '</span>'
                : (reg.known ? '<span class="text-muted vd-chains">-</span>'
                             : '<span class="badge ' + reg.badge + ' vd-chains">unknown</span>'));
    html += vdRow('Active Stake', vdAmount(d.active_stake) + ' <span class="text-muted small">over '
                + vdEsc(Number(d.position_count) || 0) + ' position(s)</span>');
    html += vdRow('STAKE Action', vdAction(d.stake_action_index)
                + (isNull(d.version) ? '' : ' <span class="badge text-bg-secondary">v' + vdEsc(d.version) + '</span>'));
    html += vdRow('Activation Block',   vdBlock(d.activation_block));
    html += vdRow('Deactivation Block', isNull(d.deactivation_block)
                ? '<span class="text-muted">still active</span>' : vdBlock(d.deactivation_block));
    html += vdRow('Recorded At Block',  vdBlock(d.block_index));
    return html;
}

// Hub registry panel. The unknown state gets its own explanatory sentence: a
// bare "unavailable" badge invites the reader to assume the validator is absent
// from the registry, which is the mistake this whole branch exists to prevent.
function renderValidatorRegistry(d){
    var reg  = validatorRegistryState(d);
    var html = '<div class="mb-2 vd-registry" data-registry="' + vdEsc(reg.key) + '">';
    html += '<span class="badge ' + reg.badge + '">' + vdEsc(reg.label) + '</span>';
    html += '</div>';
    if(reg.key === 'unknown'){
        html += '<div class="alert alert-warning py-2 mb-0 small vd-registry-note">'
             +  'The hub federation registry could not be read, so this validator\'s registry entry is UNKNOWN. '
             +  'This is not a statement that it is unregistered.</div>';
        return html;
    }
    if(reg.key === 'unregistered'){
        html += '<div class="small text-muted vd-registry-note">The hub registry was read and carries no entry for this signing pubkey. '
             +  'On-chain stake and capabilities below are unaffected.</div>';
        return html;
    }
    html += '<table class="table table-sm table-borderless mb-0"><tbody>';
    html += vdRow('Hub Address', isNull(reg.entry.addr) ? '-' : '<span class="font-monospace small">' + vdEsc(reg.entry.addr) + '</span>');
    html += vdRow('Chains',      isNull(reg.entry.chains) ? '<span class="text-muted">not reported</span>' : vdEsc(reg.entry.chains));
    html += vdRow('Hub Status',  isNull(reg.entry.status) ? '-' : vdEsc(reg.entry.status));
    html += '</tbody></table>';
    return html;
}

// Per-capability badges with their self-test state.
function renderValidatorCapabilities(d){
    var reg  = validatorRegistryState(d);
    var rows = Array.isArray(d.capabilities) ? d.capabilities : [];
    var html = '';
    if(!rows.length){
        // An empty capability list from a hub that ANSWERED is a real "qualified
        // for nothing"; an empty list with an unreadable registry is not evidence
        // of anything, and the two are told apart rather than sharing a message.
        html += (reg.known)
            ? vdEmpty('This validator has not qualified for any capability.')
            : '<div class="alert alert-warning py-2 mb-0 small vd-capabilities-unknown">'
              + 'No capability rows were returned while the hub registry was unreadable, so capability state is UNKNOWN.</div>';
        return html;
    }
    html += '<div class="d-flex flex-wrap gap-2 mb-2">';
    rows.forEach(function(r){
        var s = validatorCapabilityState(r);
        html += '<span class="badge ' + s.badge + ' vd-capability" data-capability="' + vdEsc(s.capability)
             +  '" data-state="' + vdEsc(s.key) + '">'
             +  '<i class="fa ' + vdEsc(s.icon) + ' me-1"></i>'
             +  vdEsc(isNull(s.capability) ? '-' : s.capability)
             +  ' <span class="fw-normal">(' + vdEsc(s.label) + ')</span></span>';
    });
    html += '</div>';
    var body = '';
    rows.forEach(function(r){
        var s = validatorCapabilityState(r);
        body += '<tr class="vd-capability-row" data-state="' + vdEsc(s.key) + '">'
             +  '<td>' + vdEsc(isNull(s.capability) ? '-' : s.capability) + '</td>'
             +  '<td class="vd-cap-qualified">' + vdFlagBadge(s.qualified) + '</td>'
             +  '<td class="vd-cap-selftest">'  + vdFlagBadge(s.self_test_ok) + '</td>'
             +  '<td class="vd-cap-enabled">'   + vdFlagBadge(s.enabled) + '</td>'
             +  '<td>' + vdBlock(s.qualified_at_block) + '</td>'
             +  '<td>' + vdTime(s.updated_at) + '</td>'
             +  '</tr>';
    });
    html += vdTable(['Capability', 'Qualified', 'Self-Test', 'Enabled', 'Qualified At', 'Updated'], body);
    return html;
}


// Active stake, plus the STAKE / UNSTAKE trail behind it.
function renderValidatorStake(d){
    var stakes   = Array.isArray(d.stakes)   ? d.stakes   : [];
    var unstakes = Array.isArray(d.unstakes) ? d.unstakes : [];
    var html = '';
    html += '<div class="mb-2"><span class="text-muted small">Active stake</span> '
         +  '<span class="fs-5 font-monospace vd-active-stake">' + vdEsc(formatAmount(isNull(d.active_stake) ? '0' : d.active_stake)) + '</span> '
         +  '<span class="text-muted small vd-position-count">(' + vdEsc(Number(d.position_count) || 0) + ' open position(s))</span></div>';

    var body = '';
    stakes.forEach(function(r){
        var s = validatorStakeRowState(r);
        body += '<tr class="vd-stake-row" data-stake-state="' + vdEsc(s.key) + '">'
             +  '<td>' + vdAction(r.action_index) + '</td>'
             +  '<td>' + vdAmount(r.amount) + '</td>'
             +  '<td><span class="badge ' + s.badge + '">' + vdEsc(s.label) + '</span></td>'
             +  '<td>' + vdBlock(r.activation_block) + '</td>'
             +  '<td>' + (isNull(r.deactivation_block) ? '<span class="text-muted">-</span>' : vdBlock(r.deactivation_block)) + '</td>'
             +  '<td>' + vdTime(r.timestamp) + '</td>'
             +  '</tr>';
    });
    html += vdSection('STAKE positions', stakes.length, stakes.length
        ? vdTable(['Action', 'Amount', 'State', 'Activated', 'Deactivated', 'Time'], body)
        : vdEmpty('No STAKE positions.'));

    var ubody = '';
    unstakes.forEach(function(r){
        ubody += '<tr class="vd-unstake-row">'
              +  '<td>' + vdAction(r.action_index) + '</td>'
              +  '<td>' + vdAmount(r.amount) + '</td>'
              +  '<td>' + vdBlock(r.cooldown_end_block) + '</td>'
              +  '<td>' + vdBlock(r.block_index) + '</td>'
              +  '<td>' + vdEsc(isNull(r.status) ? '-' : r.status) + '</td>'
              +  '<td>' + vdTime(r.timestamp) + '</td>'
              +  '</tr>';
    });
    html += vdSection('UNSTAKE requests', unstakes.length, unstakes.length
        ? vdTable(['Action', 'Amount', 'Cooldown Ends', 'Block', 'Status', 'Time'], ubody)
        : vdEmpty('No UNSTAKE requests.'));
    return html;
}

// Delegation history, the revocations that END delegated keys, and key
// rotations. Revocations sit WITH the delegations they end (matching how the
// server composes them): read apart, a revocation inverts into its own event.
function renderValidatorDelegations(d){
    var dels = Array.isArray(d.delegations) ? d.delegations : [];
    var revs = Array.isArray(d.revocations) ? d.revocations : [];
    var rots = Array.isArray(d.rotations)   ? d.rotations   : [];
    var html = '';

    var dbody = '';
    dels.forEach(function(r){
        var ended = !isNull(r.deactivation_block);
        dbody += '<tr class="vd-delegation-row" data-delegation-state="' + (ended ? 'ended' : 'active') + '">'
              +  '<td>' + vdAction(r.action_index) + '</td>'
              +  '<td>' + vdAddress(r.source) + '</td>'
              +  '<td>' + vdBlock(r.activation_block) + '</td>'
              +  '<td>' + (ended ? vdBlock(r.deactivation_block) : '<span class="badge text-bg-success">active</span>') + '</td>'
              +  '<td>' + vdEsc(isNull(r.status) ? '-' : r.status) + '</td>'
              +  '<td>' + vdTime(r.timestamp) + '</td>'
              +  '</tr>';
    });
    html += vdSection('DELEGATE grants', dels.length, dels.length
        ? vdTable(['Action', 'Source', 'Activated', 'Deactivated', 'Status', 'Time'], dbody)
        : vdEmpty('No delegated signing keys.'));

    var rbody = '';
    revs.forEach(function(r){
        rbody += '<tr class="vd-revocation-row">'
              +  '<td>' + vdAction(r.action_index) + '</td>'
              +  '<td>' + vdAddress(r.source) + '</td>'
              +  '<td>' + vdBlock(r.deactivation_block) + '</td>'
              +  '<td>' + vdBlock(r.block_index) + '</td>'
              +  '<td>' + vdEsc(isNull(r.status) ? '-' : r.status) + '</td>'
              +  '<td>' + vdTime(r.timestamp) + '</td>'
              +  '</tr>';
    });
    html += vdSection('Key revocations', revs.length, revs.length
        ? vdTable(['Action', 'Source', 'Revoked At', 'Block', 'Status', 'Time'], rbody)
        : vdEmpty('No key revocations.'));

    var obody = '';
    rots.forEach(function(r){
        // A rotation names BOTH keys, and this validator can be on either side,
        // so the direction is drawn rather than assumed.
        obody += '<tr class="vd-rotation-row" data-target-table="' + vdEsc(r.target_table) + '">'
              +  '<td>' + vdEsc(isNull(r.target_table) ? '-' : r.target_table) + '</td>'
              +  '<td class="font-monospace small vd-rotation-prev">' + formatHash(r.prev_signing_pubkey, 20) + '</td>'
              +  '<td class="font-monospace small vd-rotation-new">'  + formatHash(r.new_signing_pubkey, 20)  + '</td>'
              +  '<td>' + vdAction(r.delegation_action_index) + '</td>'
              +  '<td>' + vdAction(r.stake_action_index) + '</td>'
              +  '<td>' + vdBlock(r.block_index) + '</td>'
              +  '<td>' + vdTime(r.timestamp) + '</td>'
              +  '</tr>';
    });
    html += vdSection('Key rotations', rots.length, rots.length
        ? vdTable(['Target', 'Previous Key', 'New Key', 'DELEGATE Action', 'STAKE Action', 'Block', 'Time'], obody)
        : vdEmpty('No key rotations.'));
    return html;
}

// Reward accrual, the COLLECT trail that drains it, and what is left.
function renderValidatorRewards(d){
    var s    = validatorRewardSummary(d);
    var html = '';
    html += '<table class="table table-sm table-borderless mb-2"><tbody>';
    html += vdRow('Rewards Accrued',  vdAmount(s.rewards_total));
    html += vdRow('COLLECTed',        vdAmount(s.collected_total));
    html += vdRow('Claimable', s.drift
        ? '<span class="badge text-bg-danger vd-claimable" data-claimable="drift">' + vdEsc(s.claimable) + '</span>'
          + ' <span class="small text-muted">more has been COLLECTed than accrued; this is ledger drift, not a balance</span>'
        : '<span class="font-monospace vd-claimable" data-claimable="' + (s.has_claimable ? 'positive' : 'zero') + '">'
          + vdEsc(isNull(s.claimable) ? '-' : s.claimable) + '</span>');
    html += '</tbody></table>';
    // Reward accrual is per-PUBKEY while the COLLECT trail is per-ADDRESS; the
    // page says so, because the two figures are otherwise read as one account.
    html += '<div class="small text-muted mb-2">Accrual is recorded against the signing pubkey; COLLECT claims are recorded against the staking address.</div>';

    var rewards = Array.isArray(d.rewards) ? d.rewards : [];
    var rbody   = '';
    rewards.forEach(function(r){
        rbody += '<tr class="vd-reward-row" data-reward-type="' + vdEsc(r.reward_type) + '">'
              +  '<td>' + vdEsc(isNull(r.reward_type) ? '-' : r.reward_type) + '</td>'
              +  '<td>' + vdEsc(isNull(r.round_reference) ? '-' : r.round_reference) + '</td>'
              +  '<td>' + vdAmount(r.amount) + '</td>'
              +  '<td>' + vdBlock(r.block_index) + '</td>'
              +  '<td>' + vdBlock(r.derive_block_index) + '</td>'
              +  '<td>' + vdTime(r.timestamp) + '</td>'
              +  '</tr>';
    });
    html += vdSection('Reward accrual', rewards.length, rewards.length
        ? vdTable(['Type', 'Round', 'Amount', 'Block', 'Derived At', 'Time'], rbody)
        : vdEmpty('No rewards accrued.'));

    var cbody = '';
    s.collects.forEach(function(r){
        cbody += '<tr class="vd-collect-row">'
              +  '<td>' + vdAction(r.action_index) + '</td>'
              +  '<td>' + vdAmount(r.amount) + '</td>'
              +  '<td>' + vdBlock(r.block_index) + '</td>'
              +  '<td>' + vdEsc(isNull(r.status) ? '-' : r.status) + '</td>'
              +  '<td>' + vdTime(r.timestamp) + '</td>'
              +  '</tr>';
    });
    html += vdSection('COLLECT trail', s.collects.length, s.collects.length
        ? vdTable(['Action', 'Amount', 'Block', 'Status', 'Time'], cbody)
        : vdEmpty('No COLLECT claims.'));
    return html;
}

// BOTH slash families, side by side and never merged.
function renderValidatorSlashes(d){
    var families = validatorSlashFamilies(d);
    var total    = families.reduce(function(a, f){ return a + f.count; }, 0);
    var html     = '';
    if(total === 0)
        html += '<div class="mb-2"><span class="badge text-bg-success vd-slash-clean">no slash events on either path</span></div>';
    families.forEach(function(f){
        html += '<div class="mb-3 vd-slash-family" data-family="' + vdEsc(f.key) + '">';
        html += '<div class="fw-bold small mb-1">' + vdEsc(f.label)
             +  ' <span class="badge ' + (f.count ? 'text-bg-danger' : 'text-bg-light text-dark') + ' vd-slash-count">'
             +  vdEsc(f.count) + '</span></div>';
        html += '<div class="small text-muted mb-1">' + vdEsc(f.blurb) + '</div>';
        if(!f.count){
            html += vdEmpty('None recorded.');
            html += '</div>';
            return;
        }
        var body = '';
        if(f.key === 'capability'){
            f.rows.forEach(function(r){
                body += '<tr class="vd-slash-row" data-family="capability">'
                     +  '<td>' + vdAction(r.slash_action_index) + '</td>'
                     +  '<td><span class="badge text-bg-info">' + vdEsc(isNull(r.capability) ? '-' : r.capability) + '</span></td>'
                     +  '<td class="font-monospace small">' + formatHash(r.equiv_key, 20) + '</td>'
                     +  '<td>' + vdAmount(r.amount) + '</td>'
                     +  '<td>' + vdAmount(r.bounty_amount) + '</td>'
                     +  '<td>' + vdAmount(r.treasury_amount) + '</td>'
                     +  '<td>' + vdAddress(r.submitter) + '</td>'
                     +  '<td>' + vdAddress(r.destination) + '</td>'
                     +  '<td>' + vdBlock(r.block_index) + '</td>'
                     +  '<td>' + vdTime(r.timestamp) + '</td>'
                     +  '</tr>';
            });
            html += vdTable(['SLASH Action', 'Capability', 'Equivocation Key', 'Amount', 'Bounty', 'Treasury', 'Submitter', 'Destination', 'Block', 'Time'], body);
        } else {
            f.rows.forEach(function(r){
                body += '<tr class="vd-slash-row" data-family="contract">'
                     +  '<td>' + vdAction(r.execution_index) + '</td>'
                     +  '<td>' + (isNull(r.target_contract_index) ? '-' :
                                  formatLink('/' + XC.coin + '/contract/' + encodeURIComponent(r.target_contract_index),
                                             r.target_contract_index)) + '</td>'
                     +  '<td>' + vdEsc(isNull(r.tick) ? '-' : r.tick) + '</td>'
                     +  '<td>' + vdAmount(r.amount) + '</td>'
                     +  '<td>' + vdAddress(r.destination) + '</td>'
                     +  '<td>' + vdBlock(r.block_index) + '</td>'
                     +  '<td>' + vdTime(r.timestamp) + '</td>'
                     +  '</tr>';
            });
            html += vdTable(['EXECUTE Action', 'Contract', 'Token', 'Amount', 'Destination', 'Block', 'Time'], body);
        }
        html += '</div>';
    });
    return html;
}

// NODEPROOF (full-node verification) history. `passed` is the whole point of the
// row, so a failed proof is drawn as a failure rather than as a 0.
function renderValidatorNodeproofs(d){
    var rows = Array.isArray(d.nodeproofs) ? d.nodeproofs : [];
    if(!rows.length) return vdEmpty('No NODEPROOF verifications recorded.');
    var passedCount = rows.filter(function(r){ return validatorFlag(r.passed) === true; }).length;
    var html = '<div class="small text-muted mb-1 vd-nodeproof-summary">'
             + vdEsc(passedCount) + ' of ' + vdEsc(rows.length) + ' recorded verification(s) passed.</div>';
    var body = '';
    rows.forEach(function(r){
        var ok = validatorFlag(r.passed);
        body += '<tr class="vd-nodeproof-row" data-passed="' + (ok === null ? 'unknown' : (ok ? 'yes' : 'no')) + '">'
             +  '<td>' + vdAction(r.action_index) + '</td>'
             +  '<td class="font-monospace small">' + formatHash(r.challenge_id, 20) + '</td>'
             +  '<td>' + vdBlock(r.epoch_height) + '</td>'
             +  '<td>' + vdBlock(r.target_height) + '</td>'
             +  '<td>' + vdAddress(r.staking_source) + '</td>'
             +  '<td>' + vdFlagBadge(ok) + '</td>'
             +  '<td>' + vdBlock(r.block_index) + '</td>'
             +  '<td>' + vdTime(r.timestamp) + '</td>'
             +  '</tr>';
    });
    html += vdTable(['Action', 'Challenge', 'Epoch', 'Target', 'Staking Source', 'Passed', 'Block', 'Time'], body);
    return html;
}

// ATTEST accountability, one row per provider served.
function renderValidatorAttestation(d){
    var rows = validatorAttestationSummary(d.attestation_quality);
    if(!rows.length)
        return vdEmpty('No attestation accountability counters for this validator. Counters appear once it serves an ATTEST round.');
    var body = '';
    rows.forEach(function(r){
        body += '<tr class="vd-attestation-row" data-provider="' + vdEsc(r.provider_id) + '">'
             +  '<td>' + vdEsc(isNull(r.provider_id) ? '-' : r.provider_id) + '</td>'
             +  '<td>' + vdEsc(r.fulfilled_count) + '</td>'
             +  '<td>' + vdEsc(r.missed_count) + '</td>'
             +  '<td>' + vdEsc(r.slashed_count) + '</td>'
             +  '<td class="vd-attestation-rate">' + (r.fulfilled_rate === null
                    ? '<span class="text-muted">no attempts</span>'
                    : vdEsc(numeral(r.fulfilled_rate).format('0.0%'))) + '</td>'
             +  '<td>' + vdEsc(isNull(r.quality_score) ? '-' : r.quality_score) + '</td>'
             +  '<td>' + vdBlock(r.last_updated_block) + '</td>'
             +  '</tr>';
    });
    return vdTable(['Provider', 'Fulfilled', 'Missed', 'Slashed', 'Fulfilled Rate', 'Quality Score', 'Updated At'], body);
}
