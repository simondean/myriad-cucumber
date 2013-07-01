var FS = require('fs');
var Glob = require('glob');
var Path = require('path');
var Async = require('async');
var Debug = require('debug')('myriad-cucumber')

var FeatureFinder = module.exports;

FeatureFinder.find = function(options, callback) {
  Async.map(
    options.features,
    function(feature, callback) {
      FS.stat(feature, function(err, stats) {
        if (err) {
          callback(err);
        }
        else {
          if (stats.isDirectory()) {
            callback(null, Path.join(feature, '**/*.feature'));
          }
          else {
            callback(null, feature);
          }
        }
      });
    },
    function(err, globPatterns) {
      if (err) {
        callback({ message: "Failed to find the features", innerError: err });
      }
      else {
        if (globPatterns.length > 1) {
          globPatterns = '{' + globPatterns.join(',') + '}';
        }
        else {
          globPatterns = globPatterns[0];
        }

        Glob(globPatterns, { strict: true }, function(err, featureFiles) {
          if (err) {
            callback({ message: "Failed to find the features", innerError: err });
          }
          else {
            callback(null, featureFiles);
          }
        });
      }
    }
  );
}
