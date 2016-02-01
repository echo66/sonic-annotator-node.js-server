var log4js = require('log4js');
var logger = log4js.getLogger();
var misc = undefined;
var absp = require("abs");
var uuid = require('node-uuid');
var jsonfile = require('jsonfile');
var NodeCache = require("node-cache");
require('shelljs/global');

var audioFileCache = new NodeCache( { stdTTL: 60, checkperiod: 60, useClones: false } );
audioFileCache.on('expired', function(key, value) {
	logger.info("cache element expired");
	value.then((filepath) => rm(filepath))
});


function insert_features(OBJ, featuresFilepath) {
	for (var k in OBJ) {
		if (k !== 'file_metadata') {
			OBJ[k].forEach((features) => {
				var meta = features.annotation_metadata;
				var data = features.data;

				misc.get_entry('extractions', {
					tempFile : absp(featuresFilepath), 
					feature_id: meta.annotator.transform_id
				}).then((extractionEntry) => {

					extractionEntry.status = 'done';
					extractionEntry.settings = {};
					if (meta.annotator.step_size !== undefined) 
						extractionEntry.settings.step_size = meta.annotator.step_size;
					if (meta.annotator.block_size !== undefined) 
						extractionEntry.settings.block_size = meta.annotator.block_size;
					if (meta.annotator.sample_rate !== undefined) 
						extractionEntry.settings.sample_rate = meta.annotator.sample_rate;
					for (var j in meta.annotator.parameters) 
						extractionEntry.settings[j] = meta.annotator.parameters[j];
					extractionEntry.extractor = meta.annotation_tools;
					data.sort((a,b) => a.time.value - b.time.value);
					extractionEntry.data = data;
					delete extractionEntry.tempFile;
					misc.update_entry('extractions', extractionEntry).then(logger.info('updated entry'));
					rm('-f', featuresFilepath);

				}).catch((err) => logger.error(err));
			});
		}
	}
}

function extract_features(plugins, url, tempFilepath) {
	misc.sonic_annotator_extraction(plugins, url, tempFilepath)
			.then((featuresFilepath) => {
				logger.info('Finished features extraction.');
				logger.info('Reading features JSON file...');
				jsonfile.readFile(featuresFilepath, 
					function(err, OBJ) {
						logger.info('Finished reading features JSON file.');
						if (err) {
							logger.error(err);
						} else {
							insert_features(OBJ, featuresFilepath);
						}
					});
				
			})
			.catch((err) => {
				misc.get_entry('extractions', { file : absp(tempFilepath), feature_id: plugin })
						.then((entry) => {
							entry.status = 'error';
							misc.update_entry('extractions', entry)
									.then(() => logger.error(err))
									.catch((err) => logger.error(err));
						}).catch((err) => logger.error(err));

				
			});
}


process.on('message', function(data) {
	var op = data.op;

	if (op === 'init') {
		logger.info('sonic annotator extraction worker initialized');
		misc = require('./misc')(data.audioFilesDir, data.featuresFilesDir, data.sonicAnnotatorPath);
		return;
	}

	logger.info('sonic annotator extraction worker received a new request.');

	var url = data.url;

	misc.plugins_exist(data.plugins)
			.then((exist) => {
				var plugins = data.plugins;
				var tempFilepath = data.tempFile;
				
				audioFileCache.get(url, (err, value) => {
					if (!err) {
						if (value == undefined) {
							logger.info('Downloading '+url);
							var value = misc.download_file(url);
							audioFileCache.set(url, value);
						}
						value.then((filepath) => {
							extract_features(plugins, filepath, tempFilepath)
						}).catch((err) => {
							plugins.forEach((plugin) => {
								misc.get_entry('extractions', { tempFile: tempFilepath, feature_id: plugin })
										.then((entry) => {
											entry.status = 'error';
											misc.update_entry('extractions', entry)
													.then(() => logger.error(err))
													.catch((err) => logger.error(err));
										}).catch((err) => logger.error(err));
							});
						});
					} else {
						logger.error(err);
					}});
			}).catch((err) => logger.error(err));
});