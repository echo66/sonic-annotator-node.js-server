var log4js = require('log4js');
var logger = log4js.getLogger();
var misc = require('./misc')('./temp/audio', './temp/feats', '../sonic-annotator/sonic-annotator');
var absp = require("abs");
var uuid = require('node-uuid');
var jsonfile = require('jsonfile');
require('shelljs/global');


process.on('message', function(data) {
	logger.info('sonic annotator extraction worker received a new request.');
	var url = data.url;
	var plugins = [];
	
	data.plugins.forEach((plugin) => {
		misc.plugin_exists(plugin).then((exists) => {
			if (exists) 
				plugins.push(plugin);
		}).catch((err) => {
			logger.error(err);
		});
	});

	var plugins = data.plugins;
	var tempFilepath = absp('./temp/feats/' + uuid.v1());
	plugins.forEach((plugin) => {
		misc.add_entry('extractions', {
			url: url, 
			feature_id: plugin,  
			status: 'pending',
			file: tempFilepath, 
			settings: null, 
			data: null
		});
	});
	
	misc.sonic_annotator_extraction(plugins, url, tempFilepath)
			.then((featuresFilepath) => {
				jsonfile.readFile(featuresFilepath, 
					function(err, OBJ) {
						if (err) {
							logger.error(err);
						} else {
							for (var k in OBJ) {
								if (k !== 'file_metadata') {
									OBJ[k].forEach((features) => {
										var meta = features.annotation_metadata;
										var data = features.data;
										misc.get_entry('extractions', {
											file : absp(featuresFilepath), 
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
											extractionEntry.data = data;
											delete extractionEntry.file;
											misc.update_entry('extractions', extractionEntry);
											rm('-f', featuresFilepath);
										});
									});
								}
							}
						}
					});
				
			})
			.catch((err) => {
				logger.error(err);
			});
});