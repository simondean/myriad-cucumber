# myriad-cucumber

myriad task that executes tests through cucumber-js

## Usage

### Install

myriad-cucumber is available as an npm module.

myriad-cucumber and the myriad-server modules should be added to your
test codebase as dev dependencies.  You can do this with:

``` shell
$ npm install --save-dev myriad-cucumber
$ npm install --save-dev myriad-server
```

Alternatively you can manually add them to your package.json file:

``` json
{
  "devDependencies" : {
    "myriad-cucumber": "latest",
    "myriad-server": "latest"
  }
}
```

then install with:

``` shell
$ npm install --dev
```

### Config

You need to add a myriad-cucumber.js confg file to the your test codebase:

``` javascript
module.exports = {
  package: '.',
  features: ['features'],
  profiles: {
    default: {
      bin: 'node_modules/.bin/cucumber-js',
      args: ['-format', 'json']
    }
  }
};
```

Multiple profiles can be configured and the cucumber tests will be
executed multiple times, once for each profile.  This can be useful for
things like executing the same tests against both a desktop browser
and mobile browser.

``` javascript
module.exports = {
  package: '.',
  features: ['features'],
  profiles: {
    desktop: {
      bin: 'node_modules/.bin/cucumber-js',
      args: ['-format', 'json', '-t', '~@mobile-only']
    },
    mobile: {
      bin: 'node_modules/.bin/cucumber-js',
      args: ['-format', 'json', '-t', '~@desktop-only']
    }
  }
};
```

myriad-cucumber currently only works with cucumber's JSON formatter.  It
doesn't support the HTML or pretty formatters.

### Run

myriad-cucumber is executed by running the following commands in two separate terminals:

``` shell
$ node_modules/.bin/myriad-server
```

``` shell
$ node_modules/.bin/myriad-cucumber --workers 4 --myriad-server http://localhost:7777
```
