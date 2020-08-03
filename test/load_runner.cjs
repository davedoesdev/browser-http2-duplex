/*eslint-env node */

const util = require('util');
const os = require('os');

console.log = function () { // eslint-disable-line no-console
    process.stdout.write(util.format.apply(this, arguments));
    process.stdout.write(os.EOL);
};

console.error = function () { // eslint-disable-line no-console
    process.stderr.write(util.format.apply(this, arguments));
    process.stderr.write(os.EOL);
};

console.trace = function trace() { // eslint-disable-line no-console
    var err = new Error();
    err.name = 'Trace';
    err.message = util.format.apply(this, arguments);
    Error.captureStackTrace(err, trace);
    this.error(err.stack);
};

module.exports = require('./runner.cjs');
