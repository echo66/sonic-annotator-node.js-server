module.exports = function(sonicAnnotatorPath, audioFilesDir, featuresFilesDir) {
	var absp = require("abs");

	var PATH_AUDIO_FILES 	= absp(audioFilesDir || './temp/audio');
	var PATH_FEATURES_FILES = absp(featuresFilesDir || './temp/feats');
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
		var features = req.query.features || [];
		if (features.length == 0)
			res.status(500).json({message: 'You need to specify, at least, one feature.'});

		var tempFilepath = absp('./temp/feats/' + uuid.v1());
		var promises = [];
		featuresToExtract = [];

		features.forEach((featureID) => {
			promises.push(new Promise((resolve, reject) => {
				misc.get_entry('extractions', {url: url, feature_id: featureID})
						.then((entry) => {
							if (entry) {

								if (req.query.stats && req.query.intervals && entry.data) {
									var stats = req.query.stats;
									var intervals = req.query.intervals;

									misc.intervals_pre_processing(req.query.intervals)
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
									url: url, 
									feature_id: featureID,  
									status: 'pending',
									tempFile: tempFilepath, 
									settings: null, 
									data: null
								};
								misc.add_entry('extractions', obj)
										.then((entry) => {
											featuresToExtract.push(entry.feature_id)
											resolve(entry);
										}).catch((err) => error2(err, reject));
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
		}, (err) => error1(err, res));
	});
	
	
	// TODO: DEPRECATE THIS
	router.get('/summary', (req, res) => {
		var url = req.query.url;
		var feature = req.query.feature;
		var stats = req.query.stats || [];
		if (stats == 'all') {
			stats = new Array();
			STATS.forEach((stat) => stats.push(stat));
		} 

		misc.intervals_pre_processing(req.query.intervals)
				.then((O1) => {
					misc.get_entry('extractions', { url: url })
							.then((entry) => {
								misc.group_interval_data(entry.data, O1.intervals, O1.intervalsMap, O1.minStart, O1.maxEnd)
										.then((O2) => {
											misc.summary(O2.intervals, O2.intervalsMap, stats)
													.then((summary) => {
														res.send(summary);
													}).catch((err) => error1(err, res));
										}).catch((err) => error1(err, res));
							}).catch((err) => error1(err, res));
					
				}).catch((err) => error1(err, res));
	});


	// TODO: DEPRECATE THIS
	/* Retrieve features within a time interval. */
	router.get('/interval', (req, res) => {
		var id = req.query.id;
		var feature = req.query.feature;
		var start = new Number(req.query.start);
		var end = new Number(req.query.end);
		interval_data(id, feature, start, end).then((intervalData) => {
			res.send(intervalData);
		}).catch((error) => error1(err, res));
	});


	return {
		router: router
	};
}