var Async = require('async');
var Glob = require('glob');
var Path = require('path');
var ChildProcess = require('child_process');
var FS = require('fs');
var Myriad = require('myriad');

var MyriadCucumber = function(argv) {
  var self = {
    run: function(callback) {
      var configFile = argv['config'];

      var config = require(Path.resolve(configFile));

      Async.parallel([function(callback) {
        getFeatureFiles(config, callback);
      }, function(callback) {
        getPackageTarball(config, callback);
      }], function(err, results) {
        if (err) {
          callback(err);
        }
        else {
          var featureFiles = results[0];
          var packageTarball = results[1];

          var tasks = [];

          featureFiles.forEach(function(featureFile) {
            Object.keys(config.profiles).forEach(function(profileName) {
              var profile = config.profiles[profileName];

              tasks.push({
                package: packageTarball.toString('base64'),
                bin: profile.bin,
                args: profile.args + [featureFile],
                env: {}
              })
            });
          });

          tasks.forEach(function(task) {
            console.log(task);
          });

          callback();
        }
      });
    }
  }

  return self;
}

module.exports = MyriadCucumber;

function getFeatureFiles(config, callback) {
  if (config.features.length == 0) {
    callback({ message: "No features have been specified in the config" });
  }
  else {
    var globPatterns = [];

    config.features.forEach(function(featuresDir) {
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
}

function getPackageTarball(config, callback) {
  var npmPackProcess = ChildProcess.spawn('npm', ['pack', config.package], {
    stdio: ['ignore', 'pipe', process.stderr]
  });

  var output = '';

  npmPackProcess.stdout.on('data', function(data) {
    output += data;
  });

  npmPackProcess.on('exit', function(code) {
    if (code === null || code !== 0) {
      callback({ message: "Failed to pack the package", exitCode: code });
    }
    else {
      lines = output.replace(/[\r\n]+$/g, '').split(/[\r\n]+/g);

      if (lines.length !== 1) {
        callback({ message: "Expected 1 line of npm pack stdout output.  Actually got " + lines.length + " lines" });
      }
      else {
        var packageTarball = lines[0];

        FS.readFile(packageTarball, function(err, data) {
          if (err) {
            callback({ message: "Failed to read the tarball produced by npn pack", error: err });
          }
          else {
            FS.unlink(packageTarball, function(err) {
              if (err) {
                callback({ message: "Failed to delete the tarball produced by npn pack", error: err });
              }
              else {
                callback(null, data);
              }
            })
          }
        });
      }
    }
  });
}

