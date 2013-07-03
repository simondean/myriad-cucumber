var FS = require('fs');
var Glob = require('glob');
var Path = require('path');
var Async = require('async');
var Debug = require('debug')('myriad-cucumber')

var FeatureFinder = module.exports;

FeatureFinder.find = function(options, callback) {
  Async.waterfall(
    [
      Async.apply(getGlobPatterns, { features: options.features }),
      ensureForwardSlashes,
      combineGlobPatterns,
      findFeatureFiles,
      getFeatureFileSizes,
      sortFeatureFilesInDescendingSizeOrder
    ],
    function(err, featureFiles) {
      if (err) {
        callback({ message: "Failed to find the features", innerError: err });
      }
      else {
        callback(null, featureFiles);
      }
    }
  )

}

function getGlobPatterns(options, callback) {
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
        callback(err);
      }
      else {
        callback(null, { globPatterns: globPatterns })
      }
    }
  );
}

function ensureForwardSlashes(options, callback) {
  var globPatterns = options.globPatterns.map(function(globPattern) {
    return globPattern.replace(/\\/g, '/');
  });

  callback(null, { globPatterns: globPatterns });
}

function combineGlobPatterns(options, callback) {
  if (options.globPatterns.length > 1) {
    callback(null, { globPattern: '{' + options.globPatterns.join(',') + '}' });
  }
  else {
    callback(null, { globPattern: options.globPatterns[0] });
  }
}

function findFeatureFiles(options, callback) {
  Glob(options.globPattern, { strict: true }, function(err, featureFiles) {
    if (err) {
      callback(err);
    }
    else {
      callback(null, { featureFiles: featureFiles });
    }
  });
}

function getFeatureFileSizes(options, callback) {
  Async.map(
    options.featureFiles,
    function(featureFile, callback) {
      FS.stat(featureFile, function(err, stats) {
        if (err) {
          callback(err);
        }
        else {
          callback(null, { path: featureFile, size: stats.size });
        }
      });
    },
    function(err, featureFiles) {
      if (err) {
        callback(err);
      }
      else {
        callback(null, { featureFiles: featureFiles });
      }
    }
  )
}

function sortFeatureFilesInDescendingSizeOrder(options, callback) {
  options.featureFiles.sort(function(a, b) {
    return b.size - a.size;
  });

  Async.map(
    options.featureFiles,
    function(featureFile, callback) {
      callback(null, featureFile.path);
    },
    callback
  );
}