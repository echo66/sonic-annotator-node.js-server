var express = require('express');
var ffmpeg = require('fluent-ffmpeg');
var app = express();
var fs = require('fs');

app.get ('/', function(req,res) {
  res.writeHead(200, {
    'Content-Type': 'audio/mpeg',
  });
  console.log(req.query.path.replace(/ /g, '%20'));
  ffmpeg(req.query.path.replace(/ /g, '%20'))
      .on('error', function(err) {
            console.log('Processing error! ' + err);
      })
      .format('mp3')
      .audioCodec('copy')
      .seekInput(req.query.start).duration(req.query.duration)
      .pipe(res, {end:true});
           
 });

  var server = app.listen(2000, function() {
  var host = server.address().address;
  var port = server.address().port;
   console.log('Example app listening at http://%s:%s', host, port);
});