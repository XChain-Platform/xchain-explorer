/* XChain Explorer Class */

const express  = require('express');
const path     = require('path');
const util     = require('./util.js');
const database = require('./db.js');

class XChainExplorer {

    // Handle constructing a class instance
    constructor(app, config){

        // XChain Indexer Version
        this.version = process.env.npm_package_version;
        this.name    = process.env.npm_package_name;

        // Setup alias to app (express)
        this.app = app;

        // Setup alias to explorer config
        this.config  = config;

        // Create instance of the utility class
        this.util = new util(this.config);

        // Create instance of the datbase class
        this.db   = new database(this);

        // Setup alias to list of supported URLs
        this.urls = this.setupUrls();

        // Define any custom headers to pass with each request
        this.headers = {
            'XChain-Explorer-Version': '1.0.0', 
            'Access-Control-Allow-Origin': '*'
        }

        // Setup empty request response
        this.response = {
            head: null, // Placeholder for any custom headers
            html: null, // Placeholder for any HTML content
            json: null, // Placeholder for any JSON content
            time: null, // Placeholder for process request timer
            code: 200   // Placeholder for HTTP response code (Default to status OK response)
        };

        // Setup wildcard listener to process requests 
        app.get('*', (req, res) => { this.processRequest(req, res); });
    }

    // Function to define a list of explorer urls
    setupUrls(){

        // Define list of URLS to parse through and determine how to process each
        let urls = {

            // Define list of static file directories to just serve out the raw file
            'static' : [
                'css',
                'fonts',
                'images',
                'js'
            ],

            // List of HTML URLs and the HTML content file to serve out
            'html' : {
                // Top level pages
                '/'                     : 'home.html',
                '/about'                : 'about.html',
                '/privacy'              : 'privacy.html',
                '/terms'                : 'terms.html',
                '/404'                  : '404.html',
                // Actions
                '/{COIN}/actions'       : 'actions.html',
                '/{COIN}/addresses'     : 'addresses.html',
                '/{COIN}/airdrops'      : 'airdrops.html',
                '/{COIN}/batches'       : 'batches.html',
                '/{COIN}/broadcasts'    : 'broadcasts.html',
                '/{COIN}/callbacks'     : 'callbacks.html',
                '/{COIN}/destroys'      : 'destroys.html',
                '/{COIN}/dividends'     : 'dividends.html',
                '/{COIN}/dispensers'    : 'dispensers.html',
                '/{COIN}/dispenses'     : 'dispenses.html',
                '/{COIN}/files'         : 'files.html',
                '/{COIN}/issues'        : 'issues.html',
                '/{COIN}/links'         : 'links.html',
                '/{COIN}/lists'         : 'lists.html',
                '/{COIN}/messages'      : 'messages.html',
                '/{COIN}/mints'         : 'mints.html',
                '/{COIN}/orders'        : 'orders.html',
                '/{COIN}/order_matches' : 'order_matches.html',
                '/{COIN}/sends'         : 'sends.html',
                '/{COIN}/sleeps'        : 'sleeps.html',
                '/{COIN}/swaps'         : 'swaps.html',
                '/{COIN}/swap_matches'  : 'swaps.html',
                '/{COIN}/sweeps'        : 'sweeps.html',
                // Misc 
                '/{COIN}/'              : 'home_coin.html',
                '/{COIN}/api'           : 'api.html',
                '/{COIN}/blocks'        : 'blocks.html',
                '/{COIN}/markets'       : 'markets.html',
                '/{COIN}/search'        : 'search.html',
                '/{COIN}/tokens'        : 'tokens.html',
                '/{COIN}/terms'         : 'terms.html',
                '/{COIN}/mempool'       : 'mempool.html',
                //  Specific Information pages
                '/{COIN}/address/{QUERY}' : 'token.html',
                '/{COIN}/action/{QUERY}'  : 'action.html',
                '/{COIN}/block/{QUERY}'   : 'block.html',
                '/{COIN}/token/{QUERY}'   : 'token.html',
                '/{COIN}/tx/{QUERY}'      : 'transaction.html'

            },

            // List of API endpoints and the related method
            'api' : {
                // API Action Endpoints                    Method                Types
                '/{COIN}/api/addresses/{QUERY}/{TYPE}'     : ['getAddresses',    ['block', 'address']],
                '/{COIN}/api/airdrops/{QUERY}/{TYPE}'      : ['getAirdrops',     ['block', 'address', 'token']],
                '/{COIN}/api/batches/{QUERY}/{TYPE}'       : ['getBatches',      ['block', 'address']],
                '/{COIN}/api/broadcasts/{QUERY}/{TYPE}'    : ['getBroadcasts',   ['block', 'address']],
                '/{COIN}/api/callbacks/{QUERY}/{TYPE}'     : ['getCallbacks',    ['block', 'address', 'token']],
                '/{COIN}/api/destroys/{QUERY}/{TYPE}'      : ['getDestroys',     ['block', 'address', 'token']],
                '/{COIN}/api/dividends/{QUERY}/{TYPE}'     : ['getDividends',    ['block', 'address', 'token']],
                '/{COIN}/api/dispensers/{QUERY}/{TYPE}'    : ['getDispensers',   ['block', 'address', 'token']],
                '/{COIN}/api/dispenses/{QUERY}/{TYPE}'     : ['getDispenses',    ['block', 'address', 'token']],
                '/{COIN}/api/files/{QUERY}/{TYPE}'         : ['getFiles',        ['block', 'address']],
                '/{COIN}/api/issues/{QUERY}/{TYPE}'        : ['getIssues',       ['block', 'address', 'token']],
                '/{COIN}/api/links/{QUERY}/{TYPE}'         : ['getLinks',        ['block', 'address']],
                '/{COIN}/api/lists/{QUERY}/{TYPE}'         : ['getLists',        ['block', 'address']],
                '/{COIN}/api/messages/{QUERY}/{TYPE}'      : ['getMessages',     ['block', 'address', 'source', 'destination']],
                '/{COIN}/api/mints/{QUERY}/{TYPE}'         : ['getMints',        ['block', 'address', 'source', 'destination', 'token']],
                '/{COIN}/api/orders/{QUERY}/{TYPE}'        : ['getOrders',       ['block', 'address', 'token']],
                '/{COIN}/api/order_edits/{QUERY}/{TYPE}'   : ['getOrderEdits',   ['block', 'address']],
                '/{COIN}/api/order_cancels/{QUERY}/{TYPE}' : ['getOrderCancels', ['block', 'address']],
                '/{COIN}/api/order_matches/{QUERY}/{TYPE}' : ['getOrderMatches', ['block']],
                '/{COIN}/api/sends/{QUERY}/{TYPE}'         : ['getSends',        ['block', 'address', 'source', 'destination', 'token']],
                '/{COIN}/api/sleeps/{QUERY}/{TYPE}'        : ['getSleeps',       ['block', 'address', 'token']],
                '/{COIN}/api/swaps/{QUERY}/{TYPE}'         : ['getSwaps',        ['block', 'address', 'token']],
                '/{COIN}/api/swap_edits/{QUERY}/{TYPE}'    : ['getSwapEdits',    ['block', 'address']],
                '/{COIN}/api/swap_cancels/{QUERY}/{TYPE}'  : ['getSwapCancels',  ['block', 'address']],
                '/{COIN}/api/swap_matches/{QUERY}/{TYPE}'  : ['getSwapMatches',  ['block']],
                '/{COIN}/api/sweeps/{QUERY}/{TYPE}'        : ['getSweeps',       ['block', 'address', 'source', 'destination']],
                // Misc API Endpoints
                '/{COIN}/api/action/{QUERY}'               : ['getAction',       'action_index'],
                '/{COIN}/api/address/{QUERY}'              : ['getAddress',      'address'],
                '/{COIN}/api/balances/{QUERY}'             : ['getBalances',     'address'],
                '/{COIN}/api/credits/{QUERY}/{TYPE}'       : ['getCredits',      ['block', 'address']],
                '/{COIN}/api/debits/{QUERY}/{TYPE}'        : ['getDebits',       ['block', 'address']], 
                '/{COIN}/api/escrows/{QUERY}/{TYPE}'       : ['getEscrows',      ['block', 'address']],
                '/{COIN}/api/history/{QUERY}'              : ['getHistory',      'address'],
                '/{COIN}/api/holders/{QUERY}'              : ['getHolders',      'token'],
                '/{COIN}/api/mempool/{QUERY}/{TYPE}'       : ['getMempool',      ['address', 'token']],
                '/{COIN}/api/network'                      : ['getNetwork'],
                '/{COIN}/api/token/{QUERY}'                : ['getToken',        'token'],
                '/{COIN}/api/tx/{QUERY}'                   : ['getTransaction',  'tx_hash']
            }, 

            // List of explorer endpoints and the related method
            'explorer' : {
                // Explorer Endpoints                           Method           Types
                '/{COIN}/explorer/addresses/{QUERY}/{TYPE}'  : ['getAddresses',  ['block', 'address']],
                '/{COIN}/explorer/airdrops/{QUERY}/{TYPE}'   : ['getAirdrops',   ['block', 'address', 'token']],
                '/{COIN}/explorer/batches/{QUERY}/{TYPE}'    : ['getBatches',    ['block', 'address']],
                '/{COIN}/explorer/broadcasts/{QUERY}/{TYPE}' : ['getBroadcasts', ['block', 'address']],
                '/{COIN}/explorer/callbacks/{QUERY}/{TYPE}'  : ['getCallbacks',  ['block', 'address', 'token']],
                '/{COIN}/explorer/credits/{QUERY}/{TYPE}'    : ['getCredits',    ['block', 'address']],
                '/{COIN}/explorer/debits/{QUERY}/{TYPE}'     : ['getDebits',     ['block', 'address']], 
                '/{COIN}/explorer/destroys/{QUERY}/{TYPE}'   : ['getDestroys',   ['block', 'address', 'token']],
                '/{COIN}/explorer/dispensers/{QUERY}/{TYPE}' : ['getDispensers', ['block', 'address', 'token']],
                '/{COIN}/explorer/dispenses/{QUERY}/{TYPE}'  : ['getDispenses',  ['block', 'address', 'token']],
                '/{COIN}/explorer/dividends/{QUERY}/{TYPE}'  : ['getDividends',  ['block', 'address', 'token']], 
                '/{COIN}/explorer/escrows/{QUERY}/{TYPE}'    : ['getEscrows',    ['block', 'address']],
                '/{COIN}/explorer/files/{QUERY}/{TYPE}'      : ['getFiles',      ['block', 'address']],
                '/{COIN}/explorer/holders/{QUERY}'           : ['getHolders',    'token'],
                '/{COIN}/explorer/issues/{QUERY}/{TYPE}'     : ['getIssues',     ['block', 'address', 'token']],
                '/{COIN}/explorer/links/{QUERY}/{TYPE}'      : ['getLinks',      ['block', 'address', 'token']],
                '/{COIN}/explorer/lists/{QUERY}/{TYPE}'      : ['getLists',      ['block', 'address']],
                '/{COIN}/explorer/messages/{QUERY}/{TYPE}'   : ['getMessages',   ['block', 'address']],
                '/{COIN}/explorer/mints/{QUERY}/{TYPE}'      : ['getMints',      ['block', 'address', 'token']],
                '/{COIN}/explorer/orders/{QUERY}/{TYPE}'     : ['getOrders',     ['block', 'address', 'token']],
                '/{COIN}/explorer/sends/{QUERY}/{TYPE}'      : ['getSends',      ['block', 'address', 'token']],
                '/{COIN}/explorer/sleeps/{QUERY}/{TYPE}'     : ['getSleeps',     ['block', 'address', 'token']],
                '/{COIN}/explorer/swaps/{QUERY}/{TYPE}'      : ['getSwaps',      ['block', 'address', 'token']],
                '/{COIN}/explorer/sweeps/{QUERY}/{TYPE}'     : ['getSweeps',     ['block', 'address']]
            }
        };

        // Setup listeners for STATIC file requests
        for(let directory of urls['static'])
            this.app.use('/' + directory, express.static(path.join(__dirname, 'content', directory)))

        // Return the urls 
        return urls;
    }

    // Function to handle processing a API request and returning a response
    async processRequest(req, res){

        // Setup empty response object
        let response = structuredClone(this.response);

        // Start tracking time to parse block
        let debugTimer = this.util.startTimer();

        // Define some data placeholders
        let total = null;
        let data  = null;

        // Define basic request config object 
        let cfg = {
            coin: null, // COIN type (BTC, LTC, DOGE)
            type: null, // Request type (html, api, explorer)
            file: null, // File content to return
            data: {
                method: null, // Method to run to get data
                search: null, // Search to pass to method
                type:   null, // Search type to pass to method
                query:  null, // Query string parameters
                order:  null, // SQL data sort order
                // Offset Information (used by explorer for paging)
                offset: {
                    action: null, // Action (first, last, next, prev)
                    value:  null  // value (action_index, etc)
                }
            },
        };

        // Split the url path up into its various parts
        let urlPath = String(req.path).substring(1).split('/');

        // Stop processing request for static content (already been processed)
        if(this.urls['static'].includes(urlPath[0]))
            return;

        // Determine the COIN using the first part of the URL path (BTC, LTC, DOGE, etc)
        let coin = String(urlPath[0]).toUpperCase();
        if(this.config['COINS'].includes(coin))
            cfg.coin = coin;

        // Determine what TYPE of request this is using the second part of the URL path
        let type = String(urlPath[1]).toLowerCase();
        cfg.type = (['api','explorer'].includes(type) && urlPath.length>2) ? type : 'html';

        // Set type / file / info config info using url matching
        for(const url in this.urls[cfg.type]){
            let parts      = String(url).substring(1).split('/');
            let match      = false;
            let info       = this.urls[cfg.type][url];
            let searchType = false;

            // Handle html page matches
            if(cfg.type=='html' && (req.path==url || parts[1]==String(urlPath[1]).toLowerCase()))
                match = true;

            // Handle explorer and api request matches
            if(!match && ['api','explorer'].includes(cfg.type)){
                if( parts[1]==String(urlPath[1]).toLowerCase() && 
                    parts[2]==String(urlPath[2]).toLowerCase()){
                    // Handle exact explorer matches without any search type
                    if(cfg.type=='explorer' && urlPath.length==3)
                        match = true;
                    // Handle setting search type
                    if(!match){
                        let infoType = typeof info[1];
                        let search = String(urlPath[4]).toLowerCase();
                        if(infoType=='string')
                            searchType = info[1];
                        if(infoType=='object' && info[1].includes(search))
                            searchType = search;
                        if(searchType)
                            match = true;
                    }
                }
            }

            // Update config object with request info
            if(match){
                if(cfg.type=='html')
                    cfg.file = info;
                if(['api','explorer'].includes(cfg.type)){
                    cfg.data.method = info[0];
                    cfg.data.search = urlPath[3];
                    cfg.data.type   = searchType;
                    cfg.data.query  = req.query;
                    // Set additional offset information used in explorer paging
                    if(cfg.type=='explorer'){
                        let q      = (req.query) ? req.query : false;
                        let offset = (q && !this.util.isNull(q.offset)) ? q.offset : false;
                        let action = (q && !this.util.isNull(q.action)) ? q.action : false;
                        cfg.data.offset.value  = offset;
                        cfg.data.offset.action = action;
                    }
                }
                break;
            }
        }

        // If we have a method defined to get some data, retrieve the requested data from the database
        if(!this.util.isNull(cfg.data.method)){
            [data, total] = await this.db.getData(cfg);

            // Placeholder for the JSON response object
            let json = {};

            // If we have a total then we are dealing with results, so get only the results we want to return
            if(this.util.isNumeric(total)){
                // Return total number of records found
                if(cfg.type=='api')
                    json.total = total;
                // Return total number of records found in format that datatables expects (https://datatables.net/manual/server-side#Returned-data)
                if(cfg.type=='explorer'){
                    json.recordsTotal    = total;
                    json.recordsFiltered = total;
                }
                json.data  = this.getPagingDataResults(cfg, data, total);
            } else {
                // Merge the data into the JSON response object
                json = data;
            }

            // Special case JSON customizations based on method called
            if(cfg.data.method=='getBalances')
                json.address = cfg.data.search;

            // Sort the json data and object properties alphabetically (OCD much?)
            if(cfg.type=='api'){
                json = this.util.ksort(json);
                for(let idx in json.data)
                    json.data[idx] = this.util.ksort(json.data[idx]);
            }

            // Store the response JSON in the response object
            response.json = json;
        }

        // If we don't have a file or method at this point, default to a 404
        if(this.util.isNull(cfg.file) && this.util.isNull(cfg.data.method)){
            cfg.file = '404.html';
            cfg.type = 'html';
            response.code = 404;
        }

        /**********************************************************
         * HTML page handler
         *********************************************************/
        if(cfg.type=='html'){
            // Define base path to html directory
            let htmlDirectory   = path.join(__dirname, 'content/html/')

            // Load HTML template
            let templateFile    = path.join(htmlDirectory, 'template.html');
            let templateExists  = await this.util.fileExists(templateFile);
            let templateContent = (templateExists) ? await this.util.fileGetContents(templateFile) : 'Error loading template file!';

            // Load HTML content
            let htmlFile    = path.join(htmlDirectory, cfg.file);
            let htmlExists  = await this.util.fileExists(htmlFile);
            let htmlContent = (htmlExists) ? await this.util.fileGetContents(htmlFile) : 'Error loading html file!';

            // Swap Content into template
            let pageContent = templateContent;

            // TODO : Swap in the content to the template
            pageContent = pageContent.replace('{TITLE}','');
            pageContent = pageContent.replace('{CANONICAL}','');
            pageContent = pageContent.replace('{DESCRIPTION}','');
            pageContent = pageContent.replace('{CONTENT}',htmlContent);

            // Store HTML response
            response.html = pageContent;
        }

        // Log the total processing time for this request (in milliseconds)
        response.time = this.util.getTimer(debugTimer);

        // Pass forward the total runtime info in a readable string in the JSON response
        if(response.json)
            response.json.runtime = this.util.getTimerString(response.time);

        // Set any custom headers
        response.head = structuredClone(this.headers);

        if(!this.util.isNull(response.time))
            response.head['XChain-Runtime-Ms'] = response.time;

        // Return any custom headers in response
        if(!this.util.isNull(response.head))
            res.set(response.head);

        // Return HTTP status Code
        res.status(response.code);

        // Return the actual response
        if(!this.util.isNull(response.json)){
            res.json(response.json);
        } else if(!this.util.isNull(response.html)){
            res.send(response.html);
        } else {
            res.send('response of last resort...');
        }

        // Log any requests which took longer than 400 milliseconds to return a response
        if(response.time > 400){
            // TODO : Dump request information to a log file

        }

        // DEBUG INFO
        console.log('path=',req.path);
        console.log('query=',req.query);
        console.log('cfg=',cfg);
        // console.log('data=',data);
    }

    // Handle looping through database results and only returning the records the user cares about using paging and limit
    getPagingDataResults(config, data, total){
        let cfg    = config;
        let type   = cfg.type;
        let max    = this.db.getMaxMethodResults(cfg.data.method);
        let q      = (cfg.data && cfg.data.query) ? cfg.data.query : false;
        let start  = (q && q.start  && this.util.isInteger(Number(q.start)))  ? q.start  : 0;
        let limit  = (q && q.limit  && this.util.isInteger(Number(q.limit)))  ? q.limit  : max;
        let length = (q && q.length && this.util.isInteger(Number(q.length))) ? q.length : 10;
        let offset = (cfg.data && cfg.data.offset && !this.util.isNull(cfg.data.offset.value))  ? cfg.data.offset.value  : false;
        let action = (cfg.data && cfg.data.offset && !this.util.isNull(cfg.data.offset.action)) ? cfg.data.offset.action : false;        
        // Set limit based on given limit and page params
        if(cfg.type=='api'){
            let page  = (q && q.page  && this.util.isInteger(Number(q.page))) ? q.page  : 1;
            start = (limit * page) - limit;
            limit = limit * page;
        }
        // Set limit based on given length and start params
        if(cfg.type=='explorer'){
            // Limit results to 100 max (except in special cases where we can not use an offset)
            if(length > 100 && !['getHolders','getBalances','getCredits','getDebits'].includes(cfg.data.method))
                limit = 100;
            limit = start + length;
        }

        // Placeholder for the results we will actually show
        let show          = [];
        let cnt           = 0;
        let count         = 0;
        let count_reverse = 0;

        // if(action=='last'){
        //     limit = total - start;
        //     console.log('limit=',limit);
        // }

        // Loop through data and determine what to return to use
        for(let idx in data){
            cnt++;
            let method = cfg.data.method;

            // Keep track of display count separate from actual count
            count = cnt;

            // Tweak count since we reverse results in some cases
            // if(['prev','last'].includes(action))
            //     count = start + (data.length - (idx - 1));

            // Stash the reverse count since latest is first in most cases
            count_reverse = this.util.bcsub(total,(count-1),0);

            if((cnt > start && cnt <= limit) || offset || action=='last'){
                let info   = data[idx];
                // For Explorer requests, pass array of fields in specific order
                if(type=='explorer'){
                    let status = (info.status=='valid') ? 1 : 0; // 1=valid, 2=invalid

                    // Handle building out locks info into nice string
                    let locks = false;
                    if(['getIssues','getTokens'].includes(method)){
                        let arr = [
                            info.lock_max_supply,
                            info.lock_mint,
                            info.lock_mint_supply,
                            info.lock_max_mint,
                            info.lock_description,
                            info.lock_sleep,
                            info.lock_rug,
                            info.lock_callback
                        ];
                        locks = arr.join('|');
                    }

                    // Build out the correct response array based on method type
                    if(method=='getAddresses')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.fee_preference, info.require_memo, status, info.action_index];
                    if(method=='getAirdrops')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.tick, info.amount, info.memo, status, info.action_index];
                    if(method=='getBatches')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, status, info.action_index];
                    if(method=='getBroadcasts')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.message, info.value, info.fee, status, info.action_index];
                    if(method=='getCallbacks')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.tick, info.callback_tick, info.callback_amount, status, info.action_index];
                    if(method=='getDestroys')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.tick, info.amount, info.callback_amount, info.memo, status, info.action_index];
                    // if(method=='getDispensers')
                    //     // TODO
                    // if(method=='getDispenses')
                    //     // TODO
                    if(method=='getDividends')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.tick, info.dividend_tick, info.amount, status, info.action_index];
                    if(method=='getFiles')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.name, info.type, info.title, status, info.action_index];
                    if(method=='getIssues')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.tick, info.max_supply, info.max_mint, locks, status, info.action_index];
                    if(method=='getLinks')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.link_action_index, info.coin, info.coin_action_index, info.memo, status, info.action_index];
                    if(method=='getLists')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.type, info.edit, status, info.action_index];
                    if(method=='getMessages')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.destination, info.plaintext_message, info.encrypted_message, status, info.action_index];
                    if(method=='getMints')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.tick, info.amount, status, info.action_index];
                    if(method=='getOrders')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.give_tick, info.give_amount, info.get_tick, info.get_amount, status, info.action_index];
                    if(method=='getSends')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.tick, info.amount, info.destination, status, info.action_index];
                    if(method=='getSleeps')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.type, info.tick, info.resume_block, status, info.action_index];
                    if(method=='getSwaps')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.give_tick, info.give_amount, info.get_tick, info.get_amount, status, info.action_index];
                    if(method=='getSweeps')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.destination, info.balances, info.ownership, status, info.action_index];

                }
                // Add data to the response array
                show.push(info);

            }
        }
        return show;
    }
}

module.exports = XChainExplorer;
