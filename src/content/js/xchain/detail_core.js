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
 * xchain.js
 *
 * Custom javascript for xchain explorer
 */

// Handle displaying transaction details
function showTransactionDetails(){
    // Setup short alias to action info object
    let o = (XC.actionInfo) ? XC.actionInfo : XC.transactionInfo;
    // Update page with basic transaction details
    let source        = (o.source)       ? formatLink('/' + XC.coin + '/address/' + o.source, o.source) : '-';
    let tx_index      = (o.tx_index)     ? formatLink('/' + XC.coin + '/transaction/' + o.tx_index, formatAmount(o.tx_index)) : '-';
    let block_index   = (o.block_index)  ? formatLink('/' + XC.coin + '/block/' + o.block_index, formatAmount(o.block_index)) : '-';
    let action_index  = (o.action_index) ? formatLink('/' + XC.coin + '/action/' + o.action_index, formatAmount(o.action_index)) : '-';
    let action_format = (isNumeric(o.action_format)) ? o.action_format : '-';
    let action        = (o.action) ? o.action : '-';
    let status        = (o.status) ? o.status : '-';
    let tx_data       = (o.tx_data) ? o.tx_data : '-';
    $('#tx-index').html(tx_index);
    $('#block').html(block_index);
    $('#action-command').text(action);
    $('#action-format').text(action_format);
    $('#action-index').html(action_index);
    $('#action-status').text(status);    
    $('#source').html(source);
    $('#tx-data').text(tx_data);
    // A VM-emitted action never had a wire string of its own, so `tx_data` here is the
    // string of the EXECUTE that emitted it. Say so, and name the parent, rather than
    // letting "Transaction Data" imply this action was broadcast in that form.
    if(o.emitted_by && isNumeric(o.emitted_by.execution_index)){
        let parent   = formatLink('/' + XC.coin + '/action/' + o.emitted_by.execution_index, formatAmount(o.emitted_by.execution_index));
        let html     = 'EXECUTE ' + parent;
        if(isNumeric(o.emitted_by.contract_index))
            html += ' on contract ' + formatLink('/' + XC.coin + '/contract/' + o.emitted_by.contract_index, formatAmount(o.emitted_by.contract_index));
        if(isNumeric(o.emitted_by.position))
            html += ' (emission #' + numeral(Number(o.emitted_by.position) + 1).format('0,0') + ')';
        $('#emitted-by').html(html);
        $('#emitted-by-row').show();
        $('#tx-data-label').text('Transaction Data (emitting EXECUTE)');
    } else {
        $('#emitted-by-row').hide();
        $('#tx-data-label').text('Transaction Data');
    }
    $('#timestamp').html(formatLivestamp(o.timestamp) + ' (' + moment.unix(o.timestamp).utcOffset(0).format() + ' GMT)');
    // Add links to block explorers next to transaction hash
    if(o.tx_hash){
        formatTransactionLink(o.tx_hash);
    } else {
       $('#tx-hash').text('-');
    }
    // Load the actions table data
    showActionDatatable('actions',o.actions);
}

// Handle displaying action details
function showActionDetails(){
    // Setup short alias to action info object
    let o = XC.actionInfo;
    // Update page with transaction details
    showTransactionDetails();
    // Display the specific actions for this tranaction
    // TODO: Cleanup this code once all actions are working (reduce to just call on show{ACTION}Details(o))
    var found = false;
    if(o.action=='ADDRESS'){          found = true;  showAddressDetails(o);         }
    if(o.action=='AIRDROP'){          found = true;  showAirdropDetails(o);         }
    if(o.action=='BATCH'){            found = true;  showBatchDetails(o);           }
    if(o.action=='BROADCAST'){        found = true;  showBroadcastDetails(o);       }
    if(o.action=='CALLBACK'){         found = true;  showCallbackDetails(o);        }
    if(o.action=='DESTROY'){          found = true;  showDestroyDetails(o);         }
    if(o.action=='DISPENSER'){        found = true;  showDispenserDetails(o);       }
    if(o.action=='DISPENSER_CANCEL'){ found = true;  showDispenserCancelDetails(o); }
    if(o.action=='DISPENSER_CLOSE'){  found = true;  showDispenserCloseDetails(o);  }
    if(o.action=='DISPENSER_EDIT'){   found = true;  showDispenserEditDetails(o);   }
    if(o.action=='DISPENSER_EXPIRE'){ found = true;  showDispenserExpireDetails(o); }
    if(o.action=='DISPENSE'){         found = true;  showDispenseDetails(o);        }
    if(o.action=='DIVIDEND'){         found = true;  showDividendDetails(o);        }
    if(o.action=='FILE'){             found = true;  showFileDetails(o);            }
    if(o.action=='ISSUE'){            found = true;  showIssueDetails(o);           }
    if(o.action=='LINK'){             found = true;  showLinkDetails(o);            }
    if(o.action=='LIST'){             found = true;  showListDetails(o);            }
    if(o.action=='MESSAGE'){          found = true;  showMessageDetails(o);         }
    if(o.action=='MINT'){             found = true;  showMintDetails(o);            }
    if(o.action=='ORDER'){            found = true;  showOrderDetails(o);           }
    if(o.action=='ORDER_CANCEL'){     found = true;  showOrderCancelDetails(o);     }
    if(o.action=='ORDER_EDIT'){       found = true;  showOrderEditDetails(o);       }
    if(o.action=='ORDER_EXPIRE'){     found = true;  showOrderExpireDetails(o);     }
    if(o.action=='ORDER_MATCH'){      found = true;  showOrderMatchDetails(o);      }
    if(o.action=='SEND'){             found = true;  showSendDetails(o);            }
    if(o.action=='SLEEP'){            found = true;  showSleepDetails(o);           }
    if(o.action=='SWAP'){             found = true;  showSwapDetails(o);            }
    if(o.action=='SWAP_CANCEL'){      found = true;  showSwapCancelDetails(o);      }
    if(o.action=='SWAP_EDIT'){        found = true;  showSwapEditDetails(o);        }
    if(o.action=='SWAP_EXPIRE'){      found = true;  showSwapExpireDetails(o);      }
    if(o.action=='SWAP_MATCH'){       found = true;  showSwapMatchDetails(o);       }
    if(o.action=='SWEEP'){            found = true;  showSweepDetails(o);           }
    if(o.action=='ATTEST'){           found = true;  showAttestDetails(o);          }
    if(o.action=='STAKE'){            found = true;  showStakeDetails(o);           }
    if(o.action=='UNSTAKE'){          found = true;  showUnstakeDetails(o);         }
    if(o.action=='DELEGATE'){         found = true;  showDelegateDetails(o);        }
    if(o.action=='COLLECT'){          found = true;  showCollectDetails(o);         }
    if(o.action=='DEPLOY'){           found = true;  showDeployDetails(o);          }
    if(o.action=='EXECUTE'){          found = true;  showExecuteDetails(o);         }
    if(o.action=='DEPOSIT'){          found = true;  showDepositDetails(o);         }
    if(o.action=='WITHDRAW'){         found = true;  showWithdrawDetails(o);        }
    if(o.action=='XCALL'){            found = true;  showXcallDetails(o);           }
    if(o.action=='XEXEC'){            found = true;  showXexecDetails(o);           }
    if(o.action=='XBRIDGE'){          found = true;  $('#info-xbridge').html(renderXbridgeAction(o)); }
    if(o.action=='CROSS_SETTLE'){     found = true;  showCrossSettleDetails(o);     }
    if(o.action=='VOTE'){             found = true;  showVoteDetails(o);            }
    if(o.action=='SLASH'){            found = true;  showSlashDetails(o);           }
    if(o.action=='COINPAY'){          found = true;  showCoinpayDetails(o);         }
    if(o.action=='COINPAY_EXPIRE'){   found = true;  showCoinpayExpireDetails(o);   }
    if(o.action=='ANCHOR'){           found = true;  showAnchorDetails(o);          }
    if(o.action=='PRICE'){            found = true;  showPriceDetails(o);           }
    if(o.action=='NODEPROOF'){        found = true;  showNodeproofDetails(o);       }
    if(o.action=='ROLLCALL'){         found = true;  showRollcallDetails(o);        }
    if(o.action=='BET'){              found = true;  showBetDetails(o);             }
    if(o.action=='BET_EXPIRE'){       found = true;  showBetExpireDetails(o);       }
    // Load the action table data for credits/debits/escrow/fees
    showActionDatatable('credit',o.credits);
    showActionDatatable('debit', o.debits);
    showActionDatatable('escrow',o.escrows);
    // Display any fees for the action
    showActionFeeDetails(o.fee);
    // Display the correct ACTION section and hide the 'No information available' message
    if(found){
        let name  = String(o.action).replaceAll('_','-').toLowerCase();
        mountActionDetailCard(name);
        $('#additionalInfoNotAvailable').hide();
    }
}

// Mount one per-type ACTION block as a detail-card (spec M2.5).
//
// This replaced a bare removeClass('d-none'). The block's markup is unchanged -
// M2.5 rules that it stays in the page - but revealing it now goes through the
// component, which also applies the row config for this type: a theme can drop
// a row or resequence one without the page emitting different markup, and the
// runtime reports a mount that could not find its block instead of leaving a
// blank panel that reads as an action carrying no detail.
//
// Falls back to the direct reveal when the runtime or the config block is
// absent, because a missing THEME layer must never cost a reader the data.
function mountActionDetailCard(name){
    let el = document.getElementById('info-' + name);
    if(!el) return false;
    if(typeof XCComponents === 'undefined' || !XCComponents.get('detail-card')){
        $(el).removeClass('d-none');
        return false;
    }
    let cards = actionDetailCardConfig();
    let rows  = (cards && cards[name] && Array.isArray(cards[name].rows)) ? cards[name].rows : [];
    let res   = XCComponents.mount(el, 'detail-card', { type: name, rows: rows, reveal: true });
    if(!res.ok)
        $(el).removeClass('d-none');
    return res.ok;
}

// Read the row configs the composer embedded in action.html. Parsed once and
// cached: showActionDetails can run more than once per view (the action panel
// re-renders when a different action is selected).
function actionDetailCardConfig(){
    if(XC.actionDetailCards !== undefined) return XC.actionDetailCards;
    XC.actionDetailCards = null;
    let node = document.getElementById('xc-action-detail-cards');
    if(node){
        try {
            let parsed = JSON.parse(node.textContent || '{}');
            XC.actionDetailCards = parsed.cards || null;
        } catch(e){
            XCLogger.error('action detail-card config is not valid JSON:', e && e.message);
        }
    }
    return XC.actionDetailCards;
}

// Display ADDRESS action information
function showAddressDetails(data){
    // ADDRESS has two unrelated subjects. v0 edits this address's preferences; v1 binds (or drops) a
    // guard contract over one action class of the account, and carries no preferences at all - showing
    // the preference rows for one rendered "Fee Preference: null" over the entire payload.
    if(data.action_format==1){
        // A REFUSED bind has no controller event to describe (the log is what consensus enforces), so
        // it shows neither row set: the page's own Status and Data fields carry the reason and the
        // attempted wire values.
        if(data.action_class != null){
            let unbind = (data.unbind==1);
            let target = (data.controller != null)
                ? formatLink('/' + XC.coin + '/action/' + data.controller, data.controller)
                : 'None';
            $('#info-address .address-action-class').text(data.action_class);
            $('#info-address .address-controller').html((unbind ? 'Unbind ' : 'Bind ') + target);
            // A bind commits the cooldown a later drop will cost; the drop itself reports when it lands.
            $('#info-address .address-cooldown').text(unbind
                ? (data.cooldown_blocks + ' blocks (drops at block ' + data.cooldown_end_block + ')')
                : (data.cooldown_blocks + ' blocks'));
            $('#info-address .address-controller-row').removeClass('d-none');
        } else {
            $('#info-address .address-controller-row').addClass('d-none');
        }
        $('#info-address .address-preference-row').addClass('d-none');
    } else {
        let preference   = (data.fee_preference) ? (' - ' + XC.fee_preferences[data.fee_preference]) : '';
        let require_memo = (data.require_memo==1) ? 'true' : 'false';
        let dispenser    = (data.dispenser_preference) ? XC.dispenser_preferences[data.dispenser_preference] : 'Not set';
        $('#info-address .address-fee-preference').text(data.fee_preference + preference);
        $('#info-address .address-require-memo').text(require_memo);
        $('#info-address .address-dispenser-preference').text(dispenser);
        $('#info-address .address-controller-row').addClass('d-none');
        $('#info-address .address-preference-row').removeClass('d-none');
    }
    $('#info-address .address-memo').text(data.memo);
}
