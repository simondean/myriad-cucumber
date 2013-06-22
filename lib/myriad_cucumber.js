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
      options.features = config.features;
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

  var tasks = [];

  options.featureFiles.forEach(function(featureFile) {
    Object.keys(options.profiles).forEach(function(profileName) {
      var profile = options.profiles[profileName];

      tasks.push({
        options: {
          package: options.package,
          localPackage: options.localPackage,
          bin: profile.bin,
          args: profile.args.concat([featureFile]),
          env: profile.env || {}
        }
      })
    });
  });

  Debug('Found ' + tasks.length + ' tasks to execute');
  Debug('Execute will be limited to ' + options.workers + ' workers');

  var workerCount = 0;

  Async.mapLimit(
    tasks,
    options.workers,
    function(task, callback) {
      var workerIndex = workerCount++;

      executeFeatureOnWorker({ workerIndex: workerIndex, myriadServerUrl: options.myriadServerUrl, task_options: task.options }, function(err, report) {
        callback(err, report);
      });
    },
    function(err, reports) {
      if (err) {
        callback(err);
      }
      else {
        Debug('Reducing ' + reports.length + ' reports into 1 report');
        var report = [].concat.apply([], reports);
        report = JSON.stringify(report);

        if (options.out) {
          Debug('Saving cucumber output to ' + options.out);
          FS.writeFile(options.out, report, function(err) {
            callback(err);
          });
        }
        else {
          Debug('Sending cucumber output to stdout');
          console.log(report);
          callback(null);
        }
      }
    }
  );
}

function executeFeatureOnWorker(options, callback) {
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

        done(null, report);
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
