module.exports = {
  package: '..',
  features: ['features'],
  profiles: {
    blue: {
      bin: 'node',
      args: ['../node_modules/.bin/cucumber-js', '-format', 'json', '-t', '@blue']
    },
    red: {
      bin: 'node',
      args: ['../node_modules/.bin/cucumber-js', '-format', 'json', '-t', '@red']
    }
  }
};