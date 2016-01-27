var mongoskin = require('mongoskin');
var bodyParser = require('body-parser');
var log4js = require('log4js');
var exec = require('child_process').exec;
var jsonfile = require('jsonfile');
var uuid = require('node-uuid');
var math = require('mathjs');
var http = require('http');
var fs = require('fs');
require('shelljs/global');


var db = mongoskin.db('mongodb://localhost/audio-features-repository');
var col = db.collection('features');
var logger = log4js.getLogger();


var PATH_AUDIO_FILES 	= audioFilesDir;
var PATH_FEATURES_FILES = featuresFilesDir;
var BINARY 				= sonicAnnotatorPath;


function summary(intervals, intervalsMap) {
	var p = new Promise((resolve, reject) => {
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
	});
	return p;
}


function group_interval_data(data, intervals, intervalsMap, minStart, maxEnd) {
	var p = new Promise((resolve, reject) => {
		// data.sort((a,b) => a.time.value - b.time.value);
		for (var i=0; i < data.length; i++) {
			var datum = data[i];
			var time = datum.time.value;
			var value = datum.value;
			if (time >= minStart) 
				if (time <= maxEnd) {
					for (var j=0; j<intervals.length; j++) {
						if (time >= intervals[j][0] && time <= intervals[j][1]) {
							intervalsMap.get(intervals[j]).push(value);
						}
					}
				} else 
					break;
		}
		resolve(intervals, intervalsMap, minStart, maxEnd);
	});
	return p;
}


function intervals_pre_processing(strIntervals) {
	var p = new Promise((resolve, reject) => {
		var intervals = new Array(strIntervals.length) || [];
		var minStart = Infinity;
		var maxEnd = -Infinity;
		var intervalsMap = new Map();
		strIntervals.forEach((e, i) => {
			e = e.split(',');
			var start = new Number(e[0]);
			var end = new Number(e[1]);
			intervals[i] = [start, end];
			intervalsMap.set(intervals[i], []);
			minStart = (minStart > start)? start : minStart;
			maxEnd = (maxEnd < end)? end : maxEnd;
		});
		intervals.sort((a,b) => a[0] - b[0]);

		resolve(intervals, intervalsMap, minStart, maxEnd);
	});
	return p;
}


function add_entry() {
	var p = new Promise((resolve, reject) => {
		var timestamp = Math.round(+new Date()/1000);
		var obj = { created_at : timestamp };
		col.insert(toInsert, {}, (err, result) => {
			if (err)	reject(err);
			else		resolve(result.ops[0]);
		});
	});
	return p;
}


function get_entry(query) {
	var p = new Promise((resolve, reject) => {
		col.findOne(query, {}, (err, result) => {
			if (err)	reject(err);
			else		resolve(result);
		});
	});
	return p;
}


function update_entry(entry) {
	// TODO
	col.update({url:url}, {'$push': out}, (err, result) => {
		if (err)
			reject(err);
		else
			resolve(result);
	});
}


function plugin_exists(plugin) {
	var p = new Promise((resolve, reject) => {
		var plugins = new Set();
		exec(BINARY + ' -l', (err, stdout, stderr) => {
			stdout.split('\n').forEach((id) => { 
				if (err) {
					reject(err);
					return;
				} 

				if (id !== '') plugins.add(id);
			}
			resolve(plugins.has(plugin));
		}));
	});
	return p;
}


function get_plugins_list() {
	var p = new Promise((resolve, reject) => {
		var plugins = new Set();
		exec(BINARY + ' -l', (err, stdout, stderr) => {
			stdout.split('\n').forEach((id) => { 
				if (err) {
					reject(err);
					return;
				} 

				if (id !== '') plugins.add(id);
			}
			resolve(plugins);
		}));
	});
	return p;
}


function download_file(url) {
	var p = new Promise((resolve, reject) => {
		var filename = uuid.v1();
		var filepath = PATH_AUDIO_FILES + '/' + filename;
		var file = fs.createWriteStream(filepath);
		var request = http.get(url, function(response) {
			response.pipe(file);
			file.on('finish', function() {
				file.close(()=>resolve(filepath));
			});
		}).on('error', function(err) { 
			fs.unlink(filepath); 
			reject(err);
		});
	});
	return p;
}


function sonic_annotator_extraction(plugins, filepath) {
	var p = new Promise((resolve, reject) => {
		var writers = '-w jams --jams-stdout';
		var featuresFilePath = PATH_FEATURES_FILES + '/' + uuid.v1();
		var commandStr = [BINARY, '-n', writers, ' -d ' + plugins.join(' -d '), '"' + filepath + '"', ' > ' + featuresFilePath].join(' ');
		var command = exec(commandStr, (err, stdout, stderr) => {
			if (err) {
				reject(err);
				return;
			}
			resolve(featuresFilePath);
		});
	});
	return p;
}


function interval_data(id, pluginID, start, end) {
	var p = new Promise((resolve, reject) => {
		col.findOne({_id: mongoskin.ObjectID(id)}, {}, (err, result) => {
			if (err) {
				reject(err);
				return;
			}
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




module.export = {
	summary : summary, 
	group_interval_data : group_interval_data, 
	intervals_pre_processing : intervals_pre_processing, 
	add_entry : add_entry, 
	get_entry : get_entry, 
	update_entry : update_entry, 
	plugin_exists : plugin_exists, 
	get_plugins_list : get_plugins_list, 
	download_file : download_file, 
	sonic_annotator_extraction : sonic_annotator_extraction, 
	interval_data : interval_data
};