/* XChain Explorer API */

const dotenv         = require('dotenv');
const http           = require('http');
const https          = require('https');
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

	// Allow reverse proxy (X-Forwarded-Proto header)
	app.enable('trust proxy');

	// Redirect HTTP to HTTPS
	app.use((req, res, next) => {
  		if(req.secure){
    		// Request is already HTTPS, continue to the next middleware/route handler
		    next();
  		} else {
    		// Remove HTTP port from host
    		let hostname = String(req.headers.host).replace(':' + config.API.port.http, '');
    		let url = 'https://' + hostname + ':' + config.API.port.https + req.url;
    		res.redirect(url);
		}
	});

	// HTTP server for redirection
	http.createServer(app).listen(config.API.port.http, () => {
  		console.log('HTTP  server listening on port', config.API.port.http);
	});

	// HTTPS server for serving out requests in a secure manner
	https.createServer(config.API.ssl, app).listen(config.API.port.https, () => {
  		console.log('HTTPS server listening on port', config.API.port.https);
	});

	// Start up the explorer instance
	const explorer = new XChainExplorer(app, config);
}

// Start up the explorer services
startApi();
