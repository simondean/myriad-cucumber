var Async = require('async');
var MyriadServer = require('myriad-server');
var Path = require('path');
var FS = require('fs');
var Debug = require('debug')('myriad-cucumber');
var Freeport = require('freeport');

var FeatureFinder = require('./feature_finder');
var Worker = require('./worker.js');

var MyriadCucumber = function(options) {
  if (!(this instanceof MyriadCucumber)) return new MyriadCucumber(options);

  var self = this;
  self.options = options;

  return self;
}

MyriadCucumber.prototype.run = function(callback) {
  var self = this;

  var configFile = self.options.configFile;
  var config = require(Path.resolve(configFile));

  self.options.localPackage = self.options.myriadServerUrl ? false : self.options.localPackage;
  self.options.package = config.package;
  self.options.profiles = config.profiles;

  self._executeFeatures(
    self.options,
    function(err, info) {
      callback(err, info);
    }
  );
}

MyriadCucumber.prototype._executeFeatures = function(options, callback) {
  var self = this;

  var embeddedMyriadServer;

  function done(err, info) {
    if (embeddedMyriadServer) {
      Debug('Closing embedded myriad-server');
      embeddedMyriadServer.close(function() {
        Debug('Closed embedded myriad-server');
        callback(err, info);
      })
    }
    else {
      Debug('No embedded myriad-server started so nothing to close');
      callback(err, info);
    }
  }

  Async.parallel(
    [
      function(callback) {
        self._prepareMyriadServer(options, function(err, info) {
          embeddedMyriadServer = info.embeddedMyriadServer;
          callback(err, info.myriadServerUrl);
        });
      },
      Async.apply(self._findFeatures, options),
      Async.apply(self._preparePackage, options)
    ],
    function(err, results) {
      if (err) {
        done(err);
      }
      else {
        options.myriadServerUrl = results[0];
        options.featurePaths = results[1];
        options.package = results[2];

        self._executeFeaturesOnMyriadServer(
          options,
          function(err, info) {
            done(err, info);
          }
        );
      }
    }
  )
}

MyriadCucumber.prototype._getOutStream = function(options, callback) {
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

MyriadCucumber.prototype._executeFeaturesOnMyriadServer = function(options, callback) {
  var self = this;

  Debug('Spawning cucumber instances');

  var outStream;
  var finished = false;
  var success = true;

  function done(err) {
    if (finished) return;
    finished = true;

    if (outStream) {
      outStream.write(']', function() {
        outStream.end();
      });
    }

    callback(err, { success: success });
  }

  Async.parallel(
    [
      Async.apply(self._getWorkerTasks, options),
      function(callback) {
        self._getOutStream(options, function(err, info) {
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
      var workers = [];

      Async.eachLimit(
        tasks,
        options.workers,
        function(task, callback) {
          var workerIndex = workerCount++;

          var worker = new Worker({
            workerIndex: workerIndex,
            myriadServerUrl: options.myriadServerUrl,
            taskOptions: task.options,
            featurePath: task.featurePath,
            dryRun: options.dryRun,
            profileName: task.profileName
          });

          workers.push(worker);

          worker.run(
            function(report, callback) {
              report = JSON.stringify(report);
              // Remove [ and ] from start and end of the JSON string
              report = report.substr(1, report.length - 2);

              if (report.length == 0) {
                Debug('Empty report');
              }
              else {
                if (firstReport) {
                  Debug('First report');
                  firstReport = false;
                }
                else {
                  Debug('Subsequent report');
                  report = ',' + report;
                }
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
            function(err, info) {
              workers.splice(workers.indexOf(worker));
              
              if (err) {
                success = false;
                callback(err);
              }
              else {
                if (!info.success) {
                  success = false;
                }
                
                callback();
              }              
            }
          );
        },
        function(err) {
          if (workers.length > 0) {
            workers.forEach(function(worker) {
              worker.end();
            });
          }

          done(err);
        }
      );
    }
  )
}

MyriadCucumber.prototype._getWorkerTasks = function(options, callback) {
  var tasks = [];

  var extraArgs = [];

  if (options.dryRun) {
    extraArgs.push('--dry-run');
  }

  options.featurePaths.forEach(function(featurePath) {
    Object.keys(options.profiles).forEach(function(profileName) {
      var profile = options.profiles[profileName];

      var env = profile.env || {};
      env.MYRIAD_CUCUMBER_PROFILE = profileName;

      var task = {
        options: {
          package: options.package,
          localPackage: options.localPackage,
          bin: profile.bin,
          args: profile.args.concat(extraArgs, [featurePath]),
          env: env
        },
        profileName: profileName,
        featurePath: featurePath
      };

      tasks.push(task)
    });
  });

  callback(null, tasks);
}

MyriadCucumber.prototype._prepareMyriadServer = function(options, callback) {
  var self = this;

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

MyriadCucumber.prototype._findFeatures = function(options, callback) {
  var self = this;

  if (options.features.length == 0) {
    callback({ message: "No features have been specified" });
  }
  else {
    FeatureFinder.find({ features: options.features, dryRun: options.dryRun }, function(err, featurePaths) {
      if (err) {
        callback(err);
      }
      else {
        callback(null, featurePaths);
      }
    });
  }
}

MyriadCucumber.prototype._preparePackage = function(options, callback) {
  var self = this;

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

module.exports = MyriadCucumber;
