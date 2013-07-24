var Path = require('path');
var Myriad = require('myriad');
var JSYAML = require('js-yaml');
var Colors = require('colors');
var Debug = require('debug')('myriad-cucumber');

var Worker = function(options) {
  if (!(this instanceof Worker)) return new Worker(options);

  var self = this;
  self.options = options;

  return self;
}

Worker.prototype.run = function(outCallback, callback) {
  var self = this;

  var debugPrefix = '#' + self.options.workerIndex + ' ';
  var finished = false;

  function done(err, report) {
    if (finished) return;
    finished = true;

    Debug(debugPrefix + 'Closing connection');
    self._myriadConnection.close(function() {
      Debug(debugPrefix + 'Closed connection');
      callback(err, report);
    });
  }

  if (!self.options.dryRun) {
    logEvent('featurePath', {
      worker: self.options.workerIndex,
      status: 'starting',
      uri: self.options.featurePath
    });
  }

  Debug(debugPrefix + 'Connecting to ' + self.options.myriadServerUrl);
  self._myriadConnection = Myriad({ url: self.options.myriadServerUrl });

  var stdout = [];

  self._myriadConnection.on('connect', function() {
    Debug(debugPrefix + 'Spawning cucumber instance');
    self._myriadConnection.spawn(self.options.taskOptions);
  });

  self._myriadConnection.on('message', function(event) {
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

      if (event.code === 0 || event.code === 1) {
        stdout = stdout.join('');
        Debug(stdout);

        var validJson = false;

        try {
          var report = JSON.parse(stdout);
          validJson = true;
        }
        catch (e) {
          if (!(e instanceof SyntaxError)) {
            throw e;
          }
        }

        if (validJson) {
          report.forEach(function(item) {
            item.profile = self.options.profileName
          });

          logReportProgress({ workerIndex: self.options.workerIndex, report: report, dryRun: self.options.dryRun });

          var success = event.code == 0;
          
          outCallback(report, function() {
            done(null, { success: success });
          });
        }
        else {
          done({ message: "Cucumber outputted invalid JSON.  Exit code " + event.code, exitCode: event.code });
        }
      }
      else {
        done({ message: "Cucumber returned a failure exit code.  Exit code " + event.code, exitCode: event.code });
      }
    }
  });
}

Worker.prototype.end = function() {
  var self = this;

  if (self._myriadConnection) {
    self._myriadConnection.close();
    self._myriadConnection = null;
  }
}

function logReportProgress(options) {
  options.report.forEach(function(item) {
    var featureUri = cleanUri(Path.relative(process.cwd(), item.uri));

    if (item.elements) {
      item.elements.forEach(function(element) {
        var elementStatus = 'stepless';

        if (element.steps) {
          var foundElementStatus = false;

          element.steps.forEach(function(step) {
            if (!foundElementStatus) {
              if (step.result) {
                elementStatus = step.result.status;
                foundElementStatus = elementStatus !== 'passed';
              }
              else {
                elementStatus = 'unknown';
                foundElementStatus = true;
              }
            }
          });
        }

        if (!options.dryRun) {
          logEvent(element.type, {
            worker: options.workerIndex,
            status: elementStatus,
            uri: featureUri + '/' + cleanUri(element.name)
          });
        }
      });
    }

    if (!options.dryRun) {
      logEvent('feature', {
        worker: options.workerIndex,
        status: 'finished',
        uri: featureUri
      });
    }
  });
}

function logEvent(key, item) {
  var event = {};
  event[key] = item;

  var eventYaml = JSYAML.safeDump(
    event,
    {
      flowLevel: 0
    }
  );

  if (item.status == 'passed') {
    eventYaml = eventYaml.green;
  }
  else if (item.status == 'failed') {
    eventYaml = eventYaml.red;
  }
  else if (item.status == 'stepless') {
    eventYaml = eventYaml.blue;
  }
  else  {
    eventYaml = eventYaml.grey;
  }

  process.stderr.write(eventYaml);
}

function cleanUri(value) {
  return value.replace(/[^a-zA-Z0-9\\/]/g, '_').replace(/\\/g, '/');
}

module.exports = Worker;