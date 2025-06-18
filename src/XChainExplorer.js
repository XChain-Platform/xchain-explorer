/* XChain Explorer Class */

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

        // Setup wildcard listener to process requests 
        app.get('*', (req, res) => { this.processRequest(req, res); });

    }

    // Function to define a list of explorer urls
    setupUrls(){
        // Define list of URLS to parse through and determine how to process each
        let urls = {
            // List of statuc URLs and the static file to serve out
            'static' : {
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
                '/{COIN}/broadcasts'    : 'broadcast.html',
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
                '/{COIN}/mempool'       : 'mempool.html'
            },

            // List of API endpoints and the related method
            'api' : {
                // API Action Endpoints             : [Method, Supported Query Type(s)]x
                '/{COIN}/api/addresses/{QUERY}'     : ['getAddresses',    ['block', 'address']],
                '/{COIN}/api/airdrops/{QUERY}'      : ['getAirdrops',     ['block', 'address', 'token']],
                '/{COIN}/api/batches/{QUERY}'       : ['getBatches',      ['block', 'address']],
                '/{COIN}/api/broadcasts/{QUERY}'    : ['getBroadcasts',   ['block', 'address']],
                '/{COIN}/api/callbacks/{QUERY}'     : ['getCallbacks',    ['block', 'address', 'token']],
                '/{COIN}/api/destroys/{QUERY}'      : ['getDestroys',     ['block', 'address', 'token']],
                '/{COIN}/api/dispensers/{QUERY}'    : ['getDispensers',   ['block', 'address', 'token']],
                '/{COIN}/api/dispenses/{QUERY}'     : ['getDispenses',    ['block', 'address', 'token']],
                '/{COIN}/api/files/{QUERY}'         : ['getFiles',        ['block', 'address']],
                '/{COIN}/api/issues/{QUERY}'        : ['getIssues',       ['block', 'address', 'token']],
                '/{COIN}/api/links/{QUERY}'         : ['getLinks',        ['block', 'address']],
                '/{COIN}/api/lists/{QUERY}'         : ['getLists',        ['block', 'address']],
                '/{COIN}/api/messages/{QUERY}'      : ['getMessages',     ['block', 'address']],
                '/{COIN}/api/mints/{QUERY}'         : ['getMints',        ['block', 'address', 'token']],
                '/{COIN}/api/orders/{QUERY}'        : ['getOrders',       ['block', 'address', 'token']],
                '/{COIN}/api/order_matches/{QUERY}' : ['getOrderMatches', ['block', 'address', 'token']],
                '/{COIN}/api/sends/{QUERY}'         : ['getSends',        ['block', 'address', 'token']],
                '/{COIN}/api/sleeps/{QUERY}'        : ['getSleeps',       ['block', 'address', 'token']],
                '/{COIN}/api/swaps/{QUERY}'         : ['getSwaps',        ['block', 'address', 'token']],
                '/{COIN}/api/swap_matches/{QUERY}'  : ['getSwapMatches',  ['block', 'address', 'token']],
                '/{COIN}/api/sweeps/{QUERY}'        : ['getSweeps',       ['block', 'address']],
                // Misc API Endpoints
                '/{COIN}/api/action/{QUERY}'        : ['getAction',       'action_index'],
                '/{COIN}/api/address/{QUERY}'       : ['getAddress',      'address'],
                '/{COIN}/api/balances/{QUERY}'      : ['getBalances',     'address'],
                '/{COIN}/api/credits/{QUERY}'       : ['getCredits',      ['block', 'address', 'token']],
                '/{COIN}/api/debits/{QUERY}'        : ['getDebits',       ['block', 'address', 'token']], 
                '/{COIN}/api/escrows/{QUERY}'       : ['getEscrows',      ['block', 'address', 'token']],
                '/{COIN}/api/history/{QUERY}'       : ['getHistory',      'address'],
                '/{COIN}/api/holders/{QUERY}'       : ['getHolders',      'token'],
                '/{COIN}/api/mempool/{QUERY}'       : ['getMempool',      ['address', 'token']],
                '/{COIN}/api/network'               : ['getNetworkInfo'],
                '/{COIN}/api/tx/{QUERY}'            : ['getTransaction',  'tx_hash']
            }, 

            // List of explorer endpoints that return lists of transactions
            'explorer' : {
                // Actions
                '/{COIN}/explorer/address/{QUERY}'       : ['explorerAddress',      ['block', 'address']],
                '/{COIN}/explorer/airdrops/{QUERY}'      : ['explorerAirdrops',     ['block', 'address', 'token']],
                '/{COIN}/explorer/batches/{QUERY}'       : ['explorerBatches',      ['block', 'address']],
                '/{COIN}/explorer/broadcasts/{QUERY}'    : ['explorerBroadcasts',   ['block', 'address']],
                '/{COIN}/explorer/callbacks/{QUERY}'     : ['explorerCallbacks',    ['block', 'address', 'token']],
                '/{COIN}/explorer/destroys/{QUERY}'      : ['explorerDestroys',     ['block', 'address', 'token']],
                '/{COIN}/explorer/dispensers/{QUERY}'    : ['explorerDispensers',   ['block', 'address', 'token']],
                '/{COIN}/explorer/dispenses/{QUERY}'     : ['explorerDispenses',    ['block', 'address', 'token']],
                '/{COIN}/explorer/files/{QUERY}'         : ['explorerFiles',        ['block', 'address']],
                '/{COIN}/explorer/issues/{QUERY}'        : ['explorerIssues',       ['block', 'address', 'token']],
                '/{COIN}/explorer/links/{QUERY}'         : ['explorerLinks',        ['block', 'address', 'token']],
                '/{COIN}/explorer/lists/{QUERY}'         : ['explorerLists',        ['block', 'address']],
                '/{COIN}/explorer/messages/{QUERY}'      : ['explorerMessages',     ['block', 'address']],
                '/{COIN}/explorer/mints/{QUERY}'         : ['explorerMints',        ['block', 'address', 'token']],
                '/{COIN}/explorer/orders/{QUERY}'        : ['explorerOrders',       ['block', 'address', 'token']],
                '/{COIN}/explorer/order_matches/{QUERY}' : ['explorerOrderMatches', ['block', 'address', 'token']],
                '/{COIN}/explorer/sends/{QUERY}'         : ['explorerSends',        ['block', 'address', 'token']],
                '/{COIN}/explorer/sleeps/{QUERY}'        : ['explorerSleeps',       ['block', 'address', 'token']],
                '/{COIN}/explorer/swaps/{QUERY}'         : ['explorerSwaps',        ['block', 'address', 'token']],
                '/{COIN}/explorer/swap_matches/{QUERY}'  : ['explorerSwapMatches',  ['block', 'address', 'token']],
                '/{COIN}/explorer/sweeps/{QUERY}'        : ['explorerSweeps',       ['block', 'address']],                
            }
        };
        return urls;
    }

    // Function to handle processing a API request and returning a response
    async processRequest(req, res){

        // Define some placeholders
        let template = null;
        let content  = null;
        let total    = null;
        let data     = null;

        // Define basic request config object 
        let cfg = {
            coin: null, // COIN type (BTC, LTC, DOGE)
            type: null, // Request type (static, api, explorer)
            file: null, // File content to return
            data: {
                method: null, // Method to run to get data
                search: null, // Search to pass to method
                type:   null, // Search type to pass to method
                query:  null, // Query string parameters
            },
        };

        // Split the url path up into its various parts
        let path = String(req.path).substring(1).split('/');

        // Determine the COIN using the first part of the path (BTC, LTC, DOGE, etc)
        let coin = String(path[0]).toUpperCase();
        if(this.config['COINS'].includes(coin))
            cfg.coin = coin;

        // Determine what TYPE of request this is using the second part of the path
        let type = String(path[1]).toLowerCase();
        cfg.type = (['api','explorer'].includes(type)) ? type : 'static';

        // Set type / file / info config info using url matching
        for(const url in this.urls[cfg.type]){
            let parts     = String(url).substring(1).split('/');
            let match     = false;
            let info      = this.urls[cfg.type][url];
            let searchType = false;

            // Handle static page matches
            if(cfg.type=='static' && (req.path==url || parts[1]==String(path[1]).toLowerCase()))
                match = true;

            // Handle explorer and api request matches
            if(['api','explorer'].includes(cfg.type)){
                if( parts[1]==String(path[1]).toLowerCase() && 
                    parts[2]==String(path[2]).toLowerCase()){
                    let infoType = typeof info[1];
                    let search = String(path[4]).toLowerCase();
                    if(infoType=='string')
                        searchType = info[1];
                    if(infoType=='object' && info[1].includes(search))
                        searchType = search;
                    if(searchType)
                        match = true;
                }
            }

            // Update config object with request info
            if(match){
                if(cfg.type=='static')
                    cfg.file = info;
                if(['api','explorer'].includes(cfg.type)){
                    cfg.data.method = info[0];
                    cfg.data.search = path[3];
                    cfg.data.type   = searchType;
                    cfg.data.query  = req.query;
                }
                break;
            }
        }

        // If we have a method defined to get some data, retrieve the requested data from the database
        if(!this.util.isNull(cfg.data.method)){
            [total, data] = await this.db.getData(cfg);

            /**********************************************************
             * API Handler 
             *********************************************************/
            if(cfg.type=='api'){
                let max   = this.db.getMaxMethodResults(cfg.data.method);
                let start = 1;
                let limit = (cfg.data.query && cfg.data.query.limit && this.util.isInteger(Number(cfg.data.query.limit))) ? cfg.data.query.limit : max;
                let page  = (cfg.data.query && cfg.data.query.page  && this.util.isInteger(Number(cfg.data.query.page)))  ? cfg.data.query.page  : 1;
                // Set vars for where we want to start in results, and number of records to display
                start = (limit * page) - limit;
                limit = limit * page;
                // Placeholder for the results we will actually show
                let show  = [];
                let cnt  = 0;
                for(let idx in data){
                    cnt++;
                    if(cnt > start && cnt <= limit)
                        show.push(data[idx]);
                }
                // Define the JSON response object
                let json = {
                    status: 'success',
                    total: total,
                    data: show,
                };
                // Special case JSON customizations based on method called
                if(cfg.data.method=='getBalances')
                    json.address = cfg.data.search;
                // Sort the json data and object properties alphabetically (OCD much?)
                json = this.util.ksort(json);
                for(let idx in json.data){
                    json.data[idx] = this.util.ksort(json.data[idx]);
                }
                // Return the JSON response with a status of 200
                res.status(200).json(json);
                return;
            }

            /**********************************************************
             * Explorer handler 
             *********************************************************/
            // Handle returning Explorer data with support for paging, limits, and offsets
            if(cfg.type=='explorer'){
                // TODO
                res.status(200).send('explorer code coming soon...');
                return;
            }
        }

        // If we don't have a file or method at this point, default to a 404
        if(this.util.isNull(cfg.file) && this.util.isNull(cfg.data.method)){
            res.status(404).send('file not found');
            return;            
        }

        /**********************************************************
         * Static page handler
         *********************************************************/
        if(cfg.type=='static'){
            res.status(200).send('static page handler coming soon');
            return;
        }

        // TODO: Add processing time info

        // DEBUG INFO
        // TODO: Remove
        // console.log('path=',req.path);
        // console.log('query=',req.query);
        // console.log('cfg=',cfg);
        // console.log('data=',data);

        res.send('response of last resort... ');
    }
}

module.exports = XChainExplorer;
