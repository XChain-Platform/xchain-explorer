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
 * UTC-literal DATETIME columns decode to the right instant on a non-UTC host.
 *
 * Setting timezone 'Z' on a pool only sets the server session zone. The
 * driver still builds the Date from the wire text with the host's local zone,
 * so a host on America/Chicago read every DATETIME hours off. Each case runs
 * in a child process because the process zone is fixed for the Node runtime.
 */

'use strict';

const path = require('path');
const { pathToFileURL } = require('url');
const { spawnSync } = require('child_process');
const { expect } = require('chai');

const POOL_SETUP = path.resolve(__dirname, '../../../src/db/connection/pool_setup.js');
const DRIVER_PACKET = pathToFileURL(
    path.join(path.dirname(require.resolve('mariadb')), '..', 'lib', 'io', 'packet.js')
).href;

// Decode one text-protocol cell the way the driver does: build a column whose
// string()/datetime() read from a packet, run the pool's typeCast over it, and
// report the driver's own default decode beside it for comparison.
const CHILD = `
const { resetPoolMaps, setNetworkPools } = require(${JSON.stringify(POOL_SETUP)});
(async () => {
    const { default: Packet } = await import(${JSON.stringify(DRIVER_PACKET)});
    const cell = (text) => {
        if (text === null) return Buffer.from([0xfb]);
        return Buffer.concat([Buffer.from([text.length]), Buffer.from(text)]);
    };
    const run = (type, text, typeCast) => {
        const buf = cell(text);
        const packet = new Packet().update(buf, 0, buf.length);
        const column = {
            type,
            string: () => packet.readAsciiStringLengthEncoded(),
            datetime: () => packet.readDateTime()
        };
        const dflt = () => (type === 'DATE' ? packet.readDate() : packet.readDateTime());
        const out = typeCast ? typeCast(column, dflt) : dflt();
        return out === null ? null : out.toISOString();
    };
    const configs = [];
    const mariadb = {
        createPool: (config) => {
            configs.push(config);
            return {};
        }
    };
    const db = {
        util: { isNull: (value) => value === null || value === undefined },
        decoderApiUrlFromConfig: () => null
    };
    resetPoolMaps(db);
    setNetworkPools(db, mariadb, {
        mainnet: {
            database: {
                indexer: {
                    db_host: 'indexer-host', db_port: 3306,
                    user: 'indexer-user', pass: 'indexer-pass', name: 'indexer-db'
                },
                decoder: {
                    db_host: 'decoder-host', db_port: 3306,
                    user: 'decoder-user', pass: 'decoder-pass', name: 'decoder-db'
                }
            }
        }
    }, 'BTC', 'mainnet');
    const [indexer, decoder] = configs;
    process.stdout.write('\\nRESULT:' + JSON.stringify({
        tz: process.env.TZ,
        poolCount: configs.length,
        indexerWired: indexer.timezone === 'Z' && typeof indexer.typeCast === 'function',
        decoderWired: decoder.timezone === 'Z' && typeof decoder.typeCast === 'function',
        sameTypeCast: indexer.typeCast === decoder.typeCast,
        indexerDatetime: run('DATETIME', '2026-03-01 12:00:00', indexer.typeCast),
        decoderDatetime: run('DATETIME', '2026-03-01 12:00:00', decoder.typeCast),
        datetimeFrac: run('DATETIME', '2026-07-04 23:59:59.250', decoder.typeCast),
        timestamp: run('TIMESTAMP', '2026-03-01 12:00:00', decoder.typeCast),
        date: run('DATE', '2026-03-01', decoder.typeCast),
        zero: run('DATETIME', '0000-00-00 00:00:00', decoder.typeCast),
        nul: run('DATETIME', null, decoder.typeCast),
        passthrough: decoder.typeCast ? decoder.typeCast(
            { type: 'VARCHAR', string: () => 'x' },
            () => 'next-called'
        ) : null,
        driverDefault: run('DATETIME', '2026-03-01 12:00:00')
    }));
})();
`;

function decodeUnder(tz){
    const res = spawnSync(process.execPath, ['-e', CHILD], {
        env: { ...process.env, TZ: tz },
        encoding: 'utf8',
        timeout: 20000
    });
    expect(res.status, res.stderr).to.equal(0);
    const line = res.stdout.split('\n').find(l => l.startsWith('RESULT:'));
    expect(line, res.stdout).to.be.a('string');
    return JSON.parse(line.slice(7));
}

describe('pool DATETIME decode on a non-UTC host', function(){
    this.timeout(30000);

    for(const tz of ['UTC', 'America/Chicago', 'Asia/Kolkata', 'Pacific/Auckland']){
        it('decodes UTC-literal values as UTC under TZ=' + tz, function(){
            const r = decodeUnder(tz);
            expect(r.poolCount).to.equal(2);
            expect(r.indexerWired).to.equal(true);
            expect(r.decoderWired).to.equal(true);
            expect(r.sameTypeCast).to.equal(true);
            expect(r.indexerDatetime).to.equal('2026-03-01T12:00:00.000Z');
            expect(r.decoderDatetime).to.equal('2026-03-01T12:00:00.000Z');
            expect(r.datetimeFrac).to.equal('2026-07-04T23:59:59.250Z');
            expect(r.timestamp).to.equal('2026-03-01T12:00:00.000Z');
            expect(r.date).to.equal('2026-03-01T00:00:00.000Z');
            expect(r.zero).to.equal(null);
            expect(r.nul).to.equal(null);
            expect(r.passthrough).to.equal('next-called');
        });
    }

    it('shows the driver default is host-zone dependent under TZ=America/Chicago', function(){
        const r = decodeUnder('America/Chicago');
        expect(r.driverDefault).to.not.equal('2026-03-01T12:00:00.000Z');
    });
});
