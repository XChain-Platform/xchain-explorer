/* XChain Explorer API */

const fs      	 = require('fs');
const express    = require('express');
const bodyParser = require('body-parser');
const helmet     = require('helmet');
const cors       = require('cors');
const jsonRouter = require('express-json-rpc-router');
const configInfo = require('./config.js');

// Parse in the explorer config information
const config = configInfo.getConfig();
