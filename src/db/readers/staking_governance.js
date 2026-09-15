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
 * XChain Explorer - staking, validator and governance readers
 *
 * stakes and unstakes, validators and the federation registry, prices and
 * oracle prices, controllers and delegations, contract stakes, slash events,
 * validator capabilities, cross-chain matches and the governance feeds.
 * One of the reader families extracted out of db/index.js.
 *
 * The family is split into parts under ./staking_governance/, one per page or
 * ledger, and this file composes them:
 *
 *   - stakes.js              capability stakes, unstakes, key revocations,
 *                            delegations, validator rewards and COLLECTs
 *   - contract_stakes.js     the contract stake ledger and VOTE delegations
 *   - validators.js          the validator set, the hub registry and capability
 *                            legs, attestation quality, full-node verifications
 *   - validator_detail.js    the composed validator page (getValidator)
 *   - address_staking.js     the composed address staking panel and the COLLECT
 *                            trail it shares with the validator page
 *   - prices_controllers.js  prices, snapshots, oracle prices, controllers and
 *                            deploy chunks
 *   - governance.js          cross-chain matches and settlements, slash events,
 *                            governance proposals, votes and slash proposals
 *
 * HOW THIS ATTACHES
 *
 * The readers are authored as a class body per part file and exported as that
 * class's prototype, and composeReaderParts folds those prototypes into the one
 * object exported here, so db/index.js can copy them onto Database.prototype verbatim. Nothing
 * here is ever instantiated: `this` is the Database instance at call time,
 * exactly as it was when these methods sat inline, so every helper
 * (this.doQuery, this.util, this.explorer, ...) resolves the same way and no
 * caller changed. An object literal would have needed a comma between every
 * method, which turns a pure move into a diff nobody can read.
 *
 ********************************************************************/

'use strict';

const { composeReaderParts } = require('../reader_parts.js');

// The parts this entry composes. A name two parts both declare throws at require
// time (composeReaderParts), so a method can never be defined in two of them.
const stakeMethods             = require('./staking_governance/stakes.js');
const contractStakeMethods     = require('./staking_governance/contract_stakes.js');
const validatorMethods         = require('./staking_governance/validators.js');
const validatorDetailMethods   = require('./staking_governance/validator_detail.js');
const addressStakingMethods    = require('./staking_governance/address_staking.js');
const priceControllerMethods   = require('./staking_governance/prices_controllers.js');
const governanceMethods        = require('./staking_governance/governance.js');

module.exports = composeReaderParts(
    stakeMethods,
    contractStakeMethods,
    validatorMethods,
    validatorDetailMethods,
    addressStakingMethods,
    priceControllerMethods,
    governanceMethods
);
