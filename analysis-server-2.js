module.exports = function(sonicAnnotatorPath, audioFilesDir, featuresFilesDir) {
	var absp = require("abs");

	var PATH_AUDIO_FILES 	= absp(audioFilesDir || './temp/audio/');
	var PATH_FEATURES_FILES = absp(featuresFilesDir || './temp/feats/');
	var PATH_BINARY 		= absp(sonicAnnotatorPath || '/home/echo66/tese/features-extractors/sonic-annotator/sonic-annotator');
	var DEFAULT_PLUGINS = [
		'vamp:nnls-chroma:nnls-chroma:chroma', 
		'vamp:qm-vamp-plugins:qm-mfcc:coefficients', 
		'vamp:qm-vamp-plugins:qm-tempotracker:beats', 
	];
	var STATS = new Set(['min', 'max', 'mean', 'std', 'var', 'median', 'sum']);

	var extractionWorker = require('child_process').fork('extraction-worker.js');
	var log4js = require('log4js');
	var router = require('express').Router();
	var misc = require('./misc')(PATH_AUDIO_FILES, PATH_FEATURES_FILES, PATH_BINARY);
	var logger = log4js.getLogger();
	var uuid = require('node-uuid');
	require('shelljs/global');

	mkdir('-p', PATH_AUDIO_FILES);
	mkdir('-p', PATH_FEATURES_FILES);

	extractionWorker.send({
		op : 'init', 
		sonicAnnotatorPath : PATH_BINARY, 
		audioFilesDir : PATH_AUDIO_FILES, 
		featuresFilesDir : PATH_FEATURES_FILES
	});

	function error1(err, res) {
		logger.error(err);
		res.status(500).send();
	}

	function error2(err, reject) {
		logger.error(err);
		reject(err);
	}


	
	router.get('/', (req, res) => {
		var url = req.query.url;
		if (url == undefined)
			res.status(500).json({message: 'You did not provide an URL.'})

		var features = req.query.features || [];
		if (features.length == 0)
			res.status(500).json({message: 'You need to specify, at least, one feature.'});

		var tempFilepath = absp(PATH_FEATURES_FILES + '/' + uuid.v1());
		var promises = [];
		featuresToExtract = [];

		features.forEach((featureID) => {
			promises.push(new Promise((resolve, reject) => {
				misc.get_entry('extractions', {url: url, feature_id: featureID})
						.then((entry) => {
							if (entry) {
								logger.info('Found existing extraction data.');

								if (entry.status == 'done') {

									var stats, intervals;

									if (req.query.intervals instanceof Array) 
										intervals = req.query.intervals;
									else 
										intervals = [(0 + "," + entry.duration)];

									if (req.query.stats instanceof Array) 
										stats = req.query.stats;
									else	
										stats = STATS;

									misc.intervals_pre_processing(intervals)
											.then((O1) => {
												misc.group_interval_data(entry.data, O1.intervals, O1.intervalsMap, O1.minStart, O1.maxEnd)
													.then((O2) => {
														misc.summary(O2.intervals, O2.intervalsMap, stats)
																.then((summary) => {
																	entry.data = summary;
																	resolve(entry);
																}).catch((err) => error2(err, reject))
													}).catch((err) => error2(err, reject));
											}).catch((err) => error2(err, reject));
									
								} else {
									logger.info('found');
									resolve(entry);
								}
								
							} else {
								var obj = {
									url: url, feature_id: featureID,  
									status: 'pending', tempFile: tempFilepath, 
									settings: null, data: null
								};
								misc.add_entry('extractions', obj)
										.then((entry) => {
											featuresToExtract.push(entry.feature_id)
											resolve(entry);
										}).catch((err) => {
											misc.get_entry('extractions', {url:url, feature_id: featureID, tempFile: tempFilepath})
													.then((entry) => {
														entry.status = 'error';
														misc.update_entry('extractions', entry);
														error2(err, reject);
													})
													.catch((err) => error2(err, reject));
										});
							}
						}).catch((err) => error2(err, reject))
			}));
		});

		Promise.all(promises).then(function(values) { 
			if (featuresToExtract.length > 0) {
				var instructions = {
					op: 'extract', 
					url: url, 
					plugins: featuresToExtract,
					tempFile: tempFilepath
				};
				extractionWorker.send(instructions);
			}
			res.json(values);
		}, (err) => {
			features.forEach((featureID) => {
				misc.get_entry('extractions', {tempFile: absp(tempFilepath), feature_id: featureID})
						.then((entry) => {
							entry.status = 'error';
							misc.update_entry('extractions', entry)
						});
			})
			
			error1(err, res);
		});
	});

	router.get('/features', (req, res) => {
		misc.get_plugins_list().then((plugins) => res.json(plugins)).catch((err) => error1(err, res));
	});


	return {
		router: router
	};
}