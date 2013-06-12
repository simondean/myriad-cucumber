var Async = require('async');
var Myriad = require('myriad');
var MyriadServer = require('myriad-server');
var Path = require('path');
var Debug = require('debug')('myriad-cucumber')
var FeatureFinder = require('./feature_finder');
var Freeport = require('freeport');

var MyriadCucumber = function(options) {
  var self = {
    run: function(callback) {
      var configFile = options.configFile;
      var localPackage = options.localPackage;

      var config = require(Path.resolve(configFile));

      Async.parallel(
        [
          function(callback) {
            if (options.myriadServerUrl) {
              callback(null, options.myriadServerUrl);
            }
            else {
              Debug('Starting embedded myriad server');
              Async.waterfall(
                [
                  function(callback) {
                    Debug('Finding a free port');
                    Freeport(function(err, port) {
                      callback(err, port);
                    });
                  },
                  function(port, callback) {
                    Debug('Using port ' + port + ' for embedded myriad server');
                    MyriadServer({ port: port }, function() {
                      Debug('Myriad server listening');
                      callback(null, port);
                    });
                  }
                ],
                function(err, port) {
                  if (err) {
                    callback(err);
                  }
                  else {
                    Debug('Started myriad server on port ' + port);
                    callback(null, 'ws://localhost:' + port);
                  }
                }
              )
            }
          },
          function(callback) {
            if (config.features.length == 0) {
              callback({ message: "No features have been specified" });
            }
            else {
              FeatureFinder.find({ features: config.features }, function(err, featureFiles) {
                if (err) {
                  callback(err);
                }
                else {
                  callback(null, featureFiles);
                }
              });
            }
          },
          function(callback) {
            if (localPackage) {
              Debug('Using local package ' + config.package);
              callback(null, config.package);
            }
            else {
              Debug('Packing ' + config.package);
              Myriad.NPM.pack({ package: config.package }, function(err, package) {
                if (err) {
                  callback(err);
                }
                else {
                  callback(null, package);
                }
              });
            }
          }
        ],
        function(err, results) {
          if (err) {
            callback(err);
          }
          else {
            var myriadServerUrl = results[0];
            var featureFiles = results[1];
            var package = results[2];

            Debug('Spawning cucumber instances');

            var tasks = [];

            featureFiles.forEach(function(featureFile) {
              Object.keys(config.profiles).forEach(function(profileName) {
                var profile = config.profiles[profileName];

                tasks.push({
                  options: {
                    package: package,
                    localPackage: localPackage,
                    bin: profile.bin,
                    args: profile.args.concat([featureFile]),
                    env: {}
                  }
                })
              });
            });

            var workerCount = 0;

            Async.mapLimit(
              tasks,
              options.workers,
              function(task, callback) {
                var workerIndex = workerCount++;
                var debugPrefix = '#' + workerIndex + ' '

                Debug(debugPrefix + 'Connecting to ' + myriadServerUrl);
                var myriadConnection = Myriad({ url: myriadServerUrl });

                var stdout = [];

                myriadConnection.on('connect', function() {
                  Debug(debugPrefix + 'Spawning cucumber instance');
                  myriadConnection.spawn(task.options);
                });

                myriadConnection.on('message', function(event) {
                  var data;

                  if (event.data) {
                    data = new Buffer(event.data, 'base64');
                  }

                  if (event.event === 'error') {
                    console.error(event.error);
                    Debug(debugPrefix + 'Error: ' + JSON.stringify(event.error));
                    callback(event.error);
                  }
                  else if (event.event === 'child_stdout') {
                    Debug(debugPrefix + 'stdout: ' + data.toString());
                    stdout.push(data);
                  }
                  else if (event.event === 'child_stderr') {
                    console.error(data.toString());
                  }
                  else if (event.event === 'child_error') {
                    console.error(event.error);
                    Debug(debugPrefix + 'Error: ' + JSON.stringify(event.error));
                    callback(event.error);
                  }
                  else if (event.event === 'child_close') {
                    Debug(debugPrefix + 'Closed.  Exit code ' + event.code);

                    if (event.code === 0) {
                      stdout = stdout.join('');
                      Debug(stdout);
                      var report = JSON.parse(stdout);
                      callback(null, report);
                    }
                    else {
                      callback({ message: "Cucumber returned a failure exit code.  Exit code " + event.code, exitCode: event.code });
                    }
                  }
                });
              },
              function(err, reports) {
                if (err) {
                  callback(err);
                }
                else {
                  Debug('Reducing ' + reports.length + ' reports into 1 report');
                  var report = [].concat.apply([], reports);
                  callback(null, report);
                }
              }
            );
          }
        }
      );
    }
  };

  return self;
}

module.exports = MyriadCucumber;
