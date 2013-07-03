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
      var configFile = options.configFile;
      var config = require(Path.resolve(configFile));

      options.localPackage = options.myriadServerUrl ? false : options.localPackage;
      options.features = options.features;
      options.package = config.package;
      options.profiles = config.profiles;

      executeFeatures(
        options,
        function(err) {
          callback(err);
        }
      );
    }
  };

  return self;
}

function executeFeatures(options, callback) {
  var embeddedMyriadServer;

  function done(err) {
    if (embeddedMyriadServer) {
      Debug('Closing embedded myriad-server');
      embeddedMyriadServer.close(function() {
        Debug('Closed embedded myriad-server');
        callback(err);
      })
    }
    else {
      Debug('No embedded myriad-server started so nothing to close');
      callback(err);
    }
  }

  Async.parallel(
    [
      function(callback) {
        prepareMyriadServer(options, function(err, info) {
          embeddedMyriadServer = info.embeddedMyriadServer;
          callback(err, info.myriadServerUrl);
        });
      },
      Async.apply(findFeatures, options),
      Async.apply(preparePackage, options)
    ],
    function(err, results) {
      if (err) {
        done(err);
      }
      else {
        options.myriadServerUrl = results[0];
        options.featureFiles = results[1];
        options.package = results[2];

        executeFeaturesOnMyriadServer(
          options,
          function(err) {
            done(err);
          }
        );
      }
    }
  )
}

function executeFeaturesOnMyriadServer(options, callback) {
  Debug('Spawning cucumber instances');

  var outStream;
  var finished = false;

  function done(err) {
    if (finished) return;
    finished = true;

    if (outStream) {
      outStream.write(']', function() {
        outStream.close();
      });
    }

    callback(err);
  }

  Async.parallel(
    [
      Async.apply(getWorkerTasks, options),
      function(callback) {
        getOutStream(options, function(err, info) {
          if (err) {
            callback(err);
          }
          else if (info.outStream) {
            outStream = info.outStream;

            outStream.on('error', function(err) {
              done(err);
            });

            outStream.write('[', function() {
              callback(null, outStream);
            });
          }
          else {
            callback();
          }
        });
      }
    ],
    function(err, results) {
      var tasks = results[0];

      Debug('Found ' + tasks.length + ' tasks to execute');
      Debug('Execution will be limited to ' + options.workers + ' workers');

      var workerCount = 0;

      var firstReport = true;

      Async.eachLimit(
        tasks,
        options.workers,
        function(task, callback) {
          var workerIndex = workerCount++;

          executeFeatureOnWorker(
            {
              workerIndex: workerIndex,
              myriadServerUrl: options.myriadServerUrl,
              task_options: task.options
            },
            function(report, callback) {
              report = JSON.stringify(report);
              // Remove [ and ] from start and end of the JSON string
              report = report.substr(1, report.length - 2);

              if (firstReport) {
                firstReport = false;
              }
              else {
                report = ',' + report;
              }

              if (outStream) {
                Debug('Saving cucumber output file');
                outStream.write(report, function() {
                  callback();
                });
              }
              else {
                Debug('Sending cucumber output to stdout');
                console.log(report);
                callback();
              }
            },
            function(err) {
              callback(err);
            }
          );
        },
        function(err) {
          done(err);
        }
      );
    }
  )
}

function getOutStream(options, callback) {
  if (options.out) {
    Debug('Saving cucumber output to ' + options.out);
    var outStream = FS.createWriteStream(options.out);
    callback(null, { outStream: outStream });
  }
  else {
    Debug('Sending cucumber output to stdout');
    callback(null, {});
  }
}

function getWorkerTasks(options, callback) {
  var tasks = [];

  var extraArgs = [];

  if (options.dryRun) {
    extraArgs.push('--dry-run');
  }

  options.featureFiles.forEach(function(featureFile) {
    Object.keys(options.profiles).forEach(function(profileName) {
      var profile = options.profiles[profileName];

      tasks.push({
        options: {
          package: options.package,
          localPackage: options.localPackage,
          bin: profile.bin,
          args: profile.args.concat(extraArgs, [featureFile]),
          env: profile.env || {}
        }
      })
    });
  });

  callback(null, tasks);
}

function executeFeatureOnWorker(options, outCallback, callback) {
  var debugPrefix = '#' + options.workerIndex + ' ';
  var myriadConnection;
  var finished = false;

  function done(err, report) {
    if (finished) return;
    finished = true;

    Debug(debugPrefix + 'Closing connection');
    myriadConnection.close(function() {
      Debug(debugPrefix + 'Closed connection');
      callback(err, report);
    });
  }

  Debug(debugPrefix + 'Connecting to ' + options.myriadServerUrl);
  myriadConnection = Myriad({ url: options.myriadServerUrl });

  var stdout = [];

  myriadConnection.on('connect', function() {
    Debug(debugPrefix + 'Spawning cucumber instance');
    myriadConnection.spawn(options.task_options);
  });

  myriadConnection.on('message', function(event) {
    var data;

    if (event.data) {
      data = new Buffer(event.data, 'base64');
    }

    if (event.event === 'error') {
      console.error(event.error);
      Debug(debugPrefix + 'Error: ' + JSON.stringify(event.error));
      done(event.error);
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
      done(event.error);
    }
    else if (event.event === 'child_close') {
      Debug(debugPrefix + 'Child closed.  Exit code ' + event.code);

      if (event.code === 0) {
        stdout = stdout.join('');
        Debug(stdout);
        var report = JSON.parse(stdout);

        logReportProgress({ workerIndex: options.workerIndex, report: report });

        outCallback(report, function() {
          done();
        });
      }
      else {
        done({ message: "Cucumber returned a failure exit code.  Exit code " + event.code, exitCode: event.code });
      }
    }
  });
}

function logReportProgress(options) {
  options.report.forEach(function(item) {
    var featureUri = cleanUri(Path.relative(process.cwd(), item.uri));

    logEvent({
      feature: {
        worker: options.workerIndex,
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
        worker: options.workerIndex,
        status: elementStatus,
        uri: featureUri + '/' + cleanUri(element.name)
      };

      logEvent(elementEvent);
    });
  });
}

function prepareMyriadServer(options, callback) {
  if (options.myriadServerUrl) {
    callback(null, { myriadServerUrl: options.myriadServerUrl });
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
          embeddedMyriadServer = MyriadServer({ port: port }, function() {
            Debug('Myriad server listening');
            callback(null, port, embeddedMyriadServer);
          });
        }
      ],
      function(err, port, embeddedMyriadServer) {
        if (err) {
          callback(err);
        }
        else {
          Debug('Started myriad server on port ' + port);
          callback(null, { myriadServerUrl: 'ws://localhost:' + port, embeddedMyriadServer: embeddedMyriadServer });
        }
      }
    )
  }
}

function findFeatures(options, callback) {
  if (options.features.length == 0) {
    callback({ message: "No features have been specified" });
  }
  else {
    FeatureFinder.find({ features: options.features }, function(err, featureFiles) {
      if (err) {
        callback(err);
      }
      else {
        callback(null, featureFiles);
      }
    });
  }
}

function preparePackage(options, callback) {
  if (options.localPackage) {
    Debug('Using local package ' + options.package);
    callback(null, options.package);
  }
  else {
    Debug('Packing ' + options.package);
    Myriad.NPM.pack({ package: options.package }, function(err, package) {
      if (err) {
        callback(err);
      }
      else {
        callback(null, package);
      }
    });
  }
}

function logEvent(event) {
  process.stderr.write(JSYAML.safeDump(
    event,
    {
      flowLevel: 0
    }
  ));
}

function cleanUri(value) {
  return value.replace(/[^a-zA-Z0-9\\/]/g, '_').replace(/\\/g, '/');
}

module.exports = MyriadCucumber;
