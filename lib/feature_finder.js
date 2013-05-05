var Glob = require('glob');
var Path = require('path');
var Debug = require('debug')('myriad-cucumber')

var FeatureFinder = module.exports;

FeatureFinder.find = function(options, callback) {
  var globPatterns = [];

  options.features.forEach(function(featuresDir) {
    globPatterns.push(Path.join(featuresDir, '**/*.feature'));
  })

  if (globPatterns.length > 1) {
    globPatterns = '{' + globPatterns.join(',') + '}';
  }
  else {
    globPatterns = globPatterns[0];
  }

  Glob(globPatterns, { strict: true }, function(err, featureFiles) {
    if (err) {
      callback(err);
    }
    else {
      callback(null, featureFiles);
    }
  });
}
