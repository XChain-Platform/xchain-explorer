/**
 * Mock database result sets for xchain-explorer unit tests
 * Each function returns arrays mimicking MariaDB query results
 */

function sendRows() {
    return [
        { action_index: 100, tx_index: 1, source: 'addr1', destination: 'addr2', tick: 'XCHAIN', amount: '1000', block_index: 500, timestamp: 1700000000, tx_hash: 'abc123', memo: null, status: 'valid' },
        { action_index: 99,  tx_index: 2, source: 'addr3', destination: 'addr4', tick: 'XCHAIN', amount: '500',  block_index: 499, timestamp: 1699999000, tx_hash: 'def456', memo: 'test', status: 'valid' }
    ];
}

function balanceRows() {
    return [
        { tick: 'XCHAIN', amount: '1000.00000000', supply: '21000000.00000000', decimals: 8, coin_price: '0.00010000' },
        { tick: 'PEPE',   amount: '500.000',       supply: '1000000.000',       decimals: 3, coin_price: '0.00001000' }
    ];
}

function holderRows() {
    return [
        { address: 'addr1', amount: '5000.00000000', tick: 'XCHAIN', supply: '21000000.00000000', decimals: 8, coin_price: '0.00010000' },
        { address: 'addr2', amount: '3000.00000000', tick: 'XCHAIN', supply: '21000000.00000000', decimals: 8, coin_price: '0.00010000' }
    ];
}

function tokenRow() {
    return [{
        tick: 'XCHAIN',
        supply: '1000000',
        max_supply: '21000000',
        max_mint: '100',
        decimals: 8,
        description: 'XChain Gas Token',
        lock_max_supply: '1',
        lock_mint: '0',
        lock_mint_supply: '0',
        lock_max_mint: '0',
        lock_description: '0',
        lock_sleep: '0',
        lock_callback: '0',
        callback_block: 0,
        callback_tick: null,
        callback_decimals: 8,
        callback_coin_price: 0,
        callback_amount: '0',
        allow_list: null,
        block_list: null,
        mint_address_max: 0,
        mint_start_block: 0,
        mint_stop_block: 0,
        owner: 'ownerAddr1',
        coin_price: 100,
        coin_floor: 50
    }];
}

function blockRow() {
    return [{ block_index: 500, timestamp: 1700000000, ledger_hash: 'ledger123', actions_hash: 'actions123', contract_hash: 'contract123' }];
}

function transactionRow() {
    return [{ tx_index: 1, tx_hash: 'abc123', block_index: 500, timestamp: 1700000000, source: 'addr1' }];
}

function actionRows() {
    return [
        { action_index: 100, action: 'SEND' },
        { action_index: 99,  action: 'ISSUE' }
    ];
}

function countRow(total) {
    return [{ total: total || 50 }];
}

function issueRows() {
    return [
        { action_index: 50, tx_index: 3, source: 'addr1', tick: 'NEWTOKEN', max_supply: '1000000', max_mint: '100', block_index: 400, timestamp: 1699000000, tx_hash: 'iss123', status: 'valid', lock_max_supply: '0', lock_mint: '0', lock_mint_supply: '0', lock_max_mint: '0', lock_description: '0', lock_sleep: '0', lock_callback: '0' }
    ];
}

function orderRows() {
    return [
        { action_index: 60, tx_index: 4, source: 'addr1', give_tick: 'XCHAIN', give_amount: '100', get_tick: 'BTC', get_amount: '0.001', block_index: 450, timestamp: 1699500000, tx_hash: 'ord123', status: 'valid' }
    ];
}

function dispenserRows() {
    return [
        { action_index: 70, tx_index: 5, source: 'addr1', give_coin: 'BTC', give_tick: 'XCHAIN', give_amount: '10', get_coin: 'BTC', get_tick: 'BTC', get_amount: '0.0001', block_index: 460, timestamp: 1699600000, tx_hash: 'disp123', status: 'valid' }
    ];
}

function blockCountRows() {
    return [
        { action: 'addresses', count: 1 },
        { action: 'airdrops', count: 0 },
        { action: 'batches', count: 0 },
        { action: 'broadcasts', count: 2 },
        { action: 'callbacks', count: 0 },
        { action: 'destroys', count: 0 },
        { action: 'dispensers', count: 1 },
        { action: 'dispenses', count: 0 },
        { action: 'dividends', count: 0 },
        { action: 'files', count: 0 },
        { action: 'issues', count: 3 },
        { action: 'links', count: 0 },
        { action: 'lists', count: 0 },
        { action: 'messages', count: 0 },
        { action: 'mints', count: 5 },
        { action: 'orders', count: 2 },
        { action: 'order_cancels', count: 0 },
        { action: 'order_edits', count: 0 },
        { action: 'order_matches', count: 1 },
        { action: 'sends', count: 10 },
        { action: 'sleeps', count: 0 },
        { action: 'swaps', count: 0 },
        { action: 'swap_cancels', count: 0 },
        { action: 'swap_edits', count: 0 },
        { action: 'swap_matches', count: 0 },
        { action: 'sweep', count: 0 }
    ];
}

function searchAddressRows() {
    return [{ address: 'addr1' }, { address: 'addr12' }];
}

function searchTokenRows() {
    return [{ tick: 'XCHAIN', description: 'Gas Token' }];
}

function marketRows() {
    return [
        { id: 1, tick1: 'XCHAIN', tick2: 'BTC', tick1_price: '0.00010000', tick1_ask: '0.00011000', tick1_bid: '0.00009000', tick2_24hr_volume: '1.50000000', tick1_24hr_change: '5.00' }
    ];
}

function historyRows() {
    return [
        { action_index: 100, action: 'SEND', block_index: 500, timestamp: 1700000000, tx_hash: 'abc123', tx_index: 1 },
        { action_index: 99,  action: 'ISSUE', block_index: 499, timestamp: 1699999000, tx_hash: 'def456', tx_index: 2 }
    ];
}

function addressIdRow() {
    return [{ id: 42 }];
}

function tickIdRow() {
    return [{ id: 7 }];
}

function actionTypeRow(type) {
    return [{ action: type || 'SEND' }];
}

module.exports = {
    sendRows,
    balanceRows,
    holderRows,
    tokenRow,
    blockRow,
    transactionRow,
    actionRows,
    countRow,
    issueRows,
    orderRows,
    dispenserRows,
    blockCountRows,
    searchAddressRows,
    searchTokenRows,
    marketRows,
    historyRows,
    addressIdRow,
    tickIdRow,
    actionTypeRow
};
