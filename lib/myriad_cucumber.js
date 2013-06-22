var Async = require('async');
var Myriad = require('myriad');
var MyriadServer = require('myriad-server');
var Path = require('path');
var FS = require('fs');
var Debug = require('debug')('myriad-cucumber');
var FeatureFinder = require('./feature_finder');
var Freeport = require('freeport');
var JSYAML = require('js-yaml');

var MyriadCucumber = function(options) {
  var self = {
    run: function(callback) {
      var myriadServer;

      function done(err) {
        Debug('Done');
        if (myriadServer) {
          Debug('Closing embedded myriad-server');
          myriadServer.close(function() {
            Debug('Closed embedded myriad-server');
            callback(err);
          })
        }
        else {
          callback(err);
        }
      }

      var configFile = options.configFile;
      var embeddedMyriadServer = !options.myriadServerUrl;
      var localPackage = embeddedMyriadServer ? options.localPackage : false;

      var config = require(Path.resolve(configFile));

      Async.parallel(
        [
          function(callback) {
            if (!embeddedMyriadServer) {
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
                    myriadServer = MyriadServer({ port: port }, function() {
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
            done(err);
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
                    env: profile.env || {}
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
                var debugPrefix = '#' + workerIndex + ' ';

                var myriadConnection;

                Async.waterfall(
                  [
                    function(callback) {
                      Debug(debugPrefix + 'Connecting to ' + myriadServerUrl);
                      myriadConnection = Myriad({ url: myriadServerUrl });

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
                          Debug(debugPrefix + 'Child stdout: ' + data.toString());
                          stdout.push(data);
                        }
                        else if (event.event === 'child_stderr') {
                          console.error(data.toString());
                        }
                        else if (event.event === 'child_error') {
                          console.error(event.error);
                          Debug(debugPrefix + 'Child rrror: ' + JSON.stringify(event.error));
                          callback(event.error);
                        }
                        else if (event.event === 'child_close') {
                          Debug(debugPrefix + 'Child closed.  Exit code ' + event.code);

                          if (event.code === 0) {
                            stdout = stdout.join('');
                            Debug(stdout);
                            var report = JSON.parse(stdout);

                            report.forEach(function(item) {
                              var featureUri = cleanUri(Path.relative(process.cwd(), item.uri));

                              logEvent({
                                feature: {
                                  worker: workerIndex,
                                  status: 'finished',
                                  uri: featureUri
                                }
                              });

                              item.elements.forEach(function(element) {
                                var elementStatus = 'stepless';

                                if (element.steps) {
                                  var foundElementStatus = false;

                                  element.steps.forEach(function(step) {
                                    if (!foundElementStatus) {
                                      elementStatus = step.result.status;
                                      foundElementStatus = elementStatus !== 'passed';
                                    }
                                  });
                                }

                                var elementEvent = {};
                                elementEvent[element.type] = {
                                  worker: workerIndex,
                                  status: elementStatus,
                                  uri: featureUri + '/' + cleanUri(element.name)
                                };

                                logEvent(elementEvent);
                              });
                            });

                            callback(null, report);
                          }
                          else {
                            callback({ message: "Cucumber returned a failure exit code.  Exit code " + event.code, exitCode: event.code });
                          }
                        }
                      });
                    },
                    function(report, callback) {
                      callback(null, report);
                    }
                  ],
                  function (err, report) {
                    Debug(debugPrefix + 'Closing connection');
                    myriadConnection.close(function() {
                      Debug(debugPrefix + 'Closed connection');
                      callback(err, report);
                    });
                  }
                )

              },
              function(err, reports) {
                if (err) {
                  done(err);
                }
                else {
                  Debug('Reducing ' + reports.length + ' reports into 1 report');
                  var report = [].concat.apply([], reports);
                  report = JSON.stringify(report);

                  if (options.out) {
                    Debug('Saving cucumber output to ' + options.out);
                    FS.writeFile(options.out, report, function(err) {
                      done(err);
                    });
                  }
                  else {
                    Debug('Sending cucumber output to stdout');
                    console.log(report);
                    done(null);
                  }
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

function logEvent(event) {
  console.error(JSYAML.safeDump(
    event,
    {
      flowLevel: 0
    }
  ).replace(/\r?\n/, ''));
}

function cleanUri(value) {
  return value.replace(/[^a-zA-Z0-9\\/]/g, '_').replace(/\\/g, '/');
}

module.exports = MyriadCucumber;
