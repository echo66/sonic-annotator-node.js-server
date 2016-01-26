var mongoskin = require('mongoskin');
var express = require('express');
var bodyParser = require('body-parser');
var cors = require('cors');
var log4js = require('log4js');
var exec = require('child_process').exec;
var jsonfile = require('jsonfile');
var uuid = require('node-uuid');
var math = require('mathjs');
var qs = require('qs');
require('shelljs/global');

var db = mongoskin.db('mongodb://localhost/audio-features-repository');
var col = db.collection('features');
var logger = log4js.getLogger();
var router = express.Router();

var app = express();
app.use(bodyParser.json());
app.use(cors());


var WRITERS = '-w jams --jams-stdout';
var BINARY = './sonic-annotator/sonic-annotator';
var DEFAULT_PLUGINS = new Set([
		'vamp:nnls-chroma:nnls-chroma:chroma', 
		'vamp:qm-vamp-plugins:qm-mfcc:coefficients', 
		'vamp:qm-vamp-plugins:qm-tempotracker:beats', 
		]);
var pluginsIDs = new Set();

exec(BINARY + ' -l', (err, stdout, stderr) => stdout.split('\n').forEach((id) => { 
	if (id !== '') 
		pluginsIDs.add(id)
}));


function data_in_interval(id, pluginID, start, end) {
	var p = new Promise((resolve, reject) => {
		col.findOne({_id: mongoskin.ObjectID(id)}, {}, (err, result) => {
			var intervalData = [];
			if (result !== null && result[pluginID] !== undefined) {
				result[pluginID][0].data.forEach((datum) => {
					if (datum.time.value >= start && datum.time.value <= end) 
						intervalData.push(datum);
				});
			}
			resolve(intervalData);
		});
	});

	return p;
}


router.get('/', function(req, res) {
	var url = req.query.url;
	var bins = req.query.bins;
	bins = (bins != undefined)? bins.split(',') : [];

	if (bins.length == 0) 
		res.status(500);
	
	col.findOne({url: url}, {}, (err1, results1) => {
		if (results1 !== null ) {
			console.log('found');
			var O = results1;
			if (bins.length > 0)
				for (var k in O) {
					if (bins.indexOf(k)==-1) {
						delete O[k];
					}
				}
			res.json(O);
		} else {
			console.log('creating new entry');

			col.insert({url: url}, {}, (err2, results2) => 
				col.findOne({url: url}, {}, (err3, results3) => 
					res.json(results3)));

			var args = [];

			bins.forEach((el) => {
				if (pluginsIDs.has(el)) 
					args.push(el);
			});
			if (args.length == 0) 
				DEFAULT_PLUGINS.forEach((el) => args.push('-d ' + el))

			mkdir('-p', '/tmp/audio-features-repository-temp-files');
			var tempFile = '/tmp/audio-features-repository-temp-files/' + uuid.v1();
			var commandStr = [BINARY, '-n', WRITERS, args.join(' '), '"'+url+'"', ' > ' + tempFile].join(' ');
			console.log(commandStr);
			const comm = exec(commandStr, 
				(err4, stdout, stderr) => {
					console.log('features acquired');
					if (err4) {
						console.error(err4);
						return;
					}
					jsonfile.readFile(tempFile, function(err, obj) {
						var out = {};
						for (var k in obj) {
							if (k == 'file_metadata') 
								out.file_metadata = obj[k];
							else {
								obj[k].forEach((extrData) => {
									out[extrData.annotation_metadata.annotator.transform_id] = {
										extraction_metadata: extrData.annotation_metadata,
										data: extrData.data
									};
								});
							}
						}
						col.update({url:url}, {'$push': out}, (err3) => {
							rm('-f', tempFile);
							console.log('all done');
						});
					});
				});

		}
	});
});

router.get('/interval', function(req, res) {
	var id = req.query.id;
	var pid = req.query.pid;
	var start = new Number(req.query.start);
	var end = new Number(req.query.end);
	data_in_interval(id, pid, start, end).then((intervalData) => {
		res.send(intervalData);
	}).catch((error)=>{
		console.error(error);
		res.status(500);
	});
});


var STATS_FUNCTIONS = new Set(['min', 'max', 'mean', 'std', 'var', 'median', 'sum']);

router.get('/summary', function(req, res) {
	var id = req.query.id;
	var pluginID = req.query.pid;
	var stats = req.query.stats || [];
	if (stats == 'all') {
		stats = new Array();
		STATS_FUNCTIONS.forEach((stat) => stats.push(stat));
	}
	var intervals = new Array(req.query.intervals.length) || [];
	var minStart = Infinity;
	var maxEnd = -Infinity;
	var intervalsMap = new Map();
	req.query.intervals.forEach((e, i) => {
		e = e.split(',');
		var start = new Number(e[0]);
		var end = new Number(e[1]);
		intervals[i] = [start, end];
		intervalsMap.set(intervals[i], []);
		minStart = (minStart > start)? start : minStart;
		maxEnd = (maxEnd < end)? end : maxEnd;
	});
	intervals.sort((a,b) => a[0] - b[0]);
	
	
	col.findOne({_id: mongoskin.ObjectID(id)}, {}, (err, result) => {
		if (result !== null && result[pluginID] !== undefined) {
			var data = result[pluginID][0].data;
			data.sort((a,b) => a.time.value - b.time.value);
			for (var i=0; i<data.length; i++) {
				var d = data[i];
				if (d.time.value >= minStart) 
					if (d.time.value <= maxEnd) {
						for (var j=0; j<intervals.length; j++) {
							if (d.time.value >= intervals[j][0] && d.time.value <= intervals[j][1]) {
								intervalsMap.get(intervals[j]).push(d.value);
							}
						}
					} else 
						break;
			}
			var summary = intervals.map((interval) => {
				var data = intervalsMap.get(interval);
				var obj = {
					start: interval[0], 
					end: interval[1], 
					nbrDatums: data.length, 
					stats: {},
				};
				if (data.length > 0 ){
					stats.forEach((stat) => {
						var op;
						switch (stat) {
							case 'min': obj.stats.min = math.min(data, 0); break;
							case 'max': obj.stats.max = math.max(data, 0); break;
							case 'mean': obj.stats.mean = math.mean(data, 0); break;
							case 'std': op = 'std'; break;
							case 'var': op = 'var'; break;
							case 'median': op = 'median'; break;
							case 'sum': op = 'sum'; break;			
						}
						if (op != undefined) {
							obj.stats[op] = new Array(data[0].length);
							for (var i=0; i<obj.stats[op].length; i++) {
								obj.stats[op][i] = math[op](data.map((datum) => {return datum[i]}))
							}
						}
					});
				}
				return obj;
			});
			res.json(summary);
		} else {
			res.status(404);
		}
	});
});


app.use('/analysis', router);

var server = app.listen(100, function () {
	var host = server.address().address;
	var port = server.address().port;

	logger.info('Example app listening at http://%s:%s', host, port);
});