var express = require('express');
var router = require('./analysis-server-2.js')().router;
var log4js = require('log4js');
var logger = log4js.getLogger();
var cors = require('cors');

var app = express();
// app.use(bodyParser.json());
app.use(cors());
app.use('/analysis', router);

var server = app.listen(3000, function () {
	var host = server.address().address;
	var port = server.address().port;

	logger.info('Example app listening at http://%s:%s', host, port);
});