/* XChain Explorer API */

const dotenv         = require('dotenv');
const express        = require('express');
const bodyParser     = require('body-parser');
const helmet         = require('helmet');
const cors           = require('cors');
const XChainExplorer = require('./XChainExplorer.js');
const configInfo     = require('./config.js');

// Parse in .env config data
dotenv.config();

// Parse in the explorer config information
const config = configInfo.getConfig();

// Parse in API host and port information
const EXPLORER_API_HOST = config.API.host;
const EXPLORER_API_PORT = config.API.port;

// Setup the basic API functionality
async function startApi(){

	// Create the app
	const app = express();

	// Use Helmet to increase security
	app.use(helmet());

	// Allow JSON requests
	app.use(bodyParser.json());

	// Allow CORS for development
	app.use(cors());

	// Start up the explorer instance
	const explorer = new XChainExplorer(app, config);

	// Start the server
	app.listen(EXPLORER_API_PORT, () => {
	    console.log('API listening on port ' + EXPLORER_API_PORT);
	});

}

// Start up the explorer services
startApi();
