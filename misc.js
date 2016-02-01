module.exports = function(audioFilesDir, featuresFilesDir, sonicAnnotatorPath) {

	var mongoskin = require('mongoskin');
	var bodyParser = require('body-parser');
	var log4js = require('log4js');
	var exec = require('child_process').exec;
	var jsonfile = require('jsonfile');
	var uuid = require('node-uuid');
	var math = require('mathjs');
	var http = require('http');
	var fs = require('fs');
	var absp = require('abs');
	require('shelljs/global');


	var db = mongoskin.db('mongodb://localhost/audio-features-extractions');
	var col = db.collection('features');
	var logger = log4js.getLogger();


	var PATH_AUDIO_FILES 	= audioFilesDir;
	var PATH_FEATURES_FILES = featuresFilesDir;
	var BINARY 				= sonicAnnotatorPath;


	function summary(intervals, intervalsMap, stats) {
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
			resolve(summary);
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
				var hop;
				if (i == data.length-1) {
					hop = Math.abs(data[i].time.value - data[i-1].time.value);
				} else {
					hop = Math.abs(data[i].time.value - data[i+1].time.value);
				}
				hop = (!isNaN(hop))? hop : Math.abs(data[i].time.value - data[i+1].time.value);
				if (time >= minStart) 
					if (time <= maxEnd) {
						for (var j=0; j<intervals.length; j++) {
							var d_start = time;
							var d_end = time + hop;
							var i_start = intervals[j][0];
							var i_end = intervals[j][1];

							if (d_start < i_end && d_end > i_start) {
								intervalsMap.get(intervals[j]).push(value);
							}
						}
					} else 
						break;
			}
			resolve({
				intervals : intervals, 
				intervalsMap : intervalsMap, 
				minStart : minStart, 
				maxEnd : maxEnd
			});
		});
		return p;
	}


	function intervals_pre_processing(strIntervals) {
		var p = new Promise((resolve, reject) => {
			var intervals = [];
			var minStart = Infinity;
			var maxEnd = -Infinity;
			var intervalsMap = new Map();
			var aux = new Set();
			strIntervals.forEach((e, i) => {
				if (aux.has(e)) return;
				aux.add(e);
				e = e.split(',');
				var start = parseFloat(e[0]);
				var end = parseFloat(e[1]);
				var interval = [start, end];
				intervals.push(interval);
				intervalsMap.set(interval, []);
				minStart = (minStart > start)? start : minStart;
				maxEnd = (maxEnd < end)? end : maxEnd;
			});
			intervals.sort((a,b) => a[0] - b[0]);

			resolve({
				intervals : intervals, 
				intervalsMap : intervalsMap, 
				minStart : minStart, 
				maxEnd : maxEnd
			});
		});
		return p;
	}


	function add_entry(collection, data) {
		var p = new Promise((resolve, reject) => {
			var timestamp = new Date();
			var obj = { created_at : timestamp };
			for (var k in data) {
				obj[k] = data[k] ;
			}
			db.collection(collection).insert(obj, {}, (err, result) => {
				if (err)	reject(err);
				else		resolve(result.ops[0]);
			});
		});
		return p;
	}


	function get_entry(collection, query) {
		var p = new Promise((resolve, reject) => {
			db.collection(collection).findOne(query, {}, (err, result) => {
				if (err)	reject(err);
				else		resolve(result);
			});
		});
		return p;
	}


	function update_entry(collection, data) {
		var p = new Promise((resolve, reject) => {
			db.collection(collection).update({_id: data._id}, data, (err, result) => {
				if (err)
					reject(err);
				else
					resolve(result);
			});
		});
		return p;
	}


	function plugin_exists(plugin) {
		var p = new Promise((resolve, reject) => {
			var plugins = new Set();
			exec(BINARY + ' -l', (err, stdout, stderr) => {
				if (err) {
					reject(err);
				} else {
					stdout.split('\n').forEach((id) => { 
						if (id !== '') plugins.add(id);	
					});
					resolve(plugins.has(plugin));
				}
			});
		});
		return p;
	}

	function plugins_exist(plugins) {
		var p = new Promise((resolve, reject) => {
			var plugins = new Set(plugins);
			exec(BINARY + ' -l', (err, stdout, stderr) => {
				if (err) {
					reject(err);
				} else {
					var aux = stdout.split('\n');
					aux.length--;
					var systemPlugins = new Set(aux);
					for (var i=0; i < plugins.length; i++) 
						if (!systemPlugins.has(plugin))
							resolve(false);
					resolve(true);
				}
			});
		});
		return p;
	}


	function get_plugins_list() {
		var p = new Promise((resolve, reject) => {
			var plugins;
			exec(BINARY + ' -l', (err, stdout, stderr) => {
				plugins = stdout.split('\n');
				plugins.length = Math.max(0, plugins.length - 1);
				resolve(plugins);
			});
		});
		return p;
	}


	function download_file(url) {
		var p = new Promise((resolve, reject) => {
			var filename = uuid.v1();
			var filepath = absp(PATH_AUDIO_FILES + '/' + filename);
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


	function sonic_annotator_extraction(plugins, audioFilepath, featuresFilePath) {
		var p = new Promise((resolve, reject) => {
			var writers = '-w jams --jams-stdout';
			var _featuresFilePath = absp(featuresFilePath || PATH_FEATURES_FILES + '/' + uuid.v1())
			var commandStr = [BINARY, '-n', writers, ' -d ' + plugins.join(' -d '), '"' + audioFilepath + '"', ' > ' + featuresFilePath].join(' ');
			console.log(commandStr);
			var command = exec(commandStr, (err, stdout, stderr) => {
				if (err) {
					reject(err);
				} else {
					resolve(_featuresFilePath);
				}
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
	
	return {
		summary : summary, 
		group_interval_data : group_interval_data, 
		intervals_pre_processing : intervals_pre_processing, 
		add_entry : add_entry, 
		get_entry : get_entry, 
		update_entry : update_entry, 
		plugin_exists : plugin_exists, 
		plugins_exist : plugins_exist,
		get_plugins_list : get_plugins_list, 
		download_file : download_file, 
		sonic_annotator_extraction : sonic_annotator_extraction, 
		interval_data : interval_data
	};
}