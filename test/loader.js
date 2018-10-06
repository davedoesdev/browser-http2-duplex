/*eslint-env node, browser */
/*global nw, http2_client_duplex_bundle */

const runner = require('./load_runner.js');
const util = require('util');
const os = require('os');

function done(err) {
    require('nw.gui').App.quit();
    if (err) {
        if (process.env.TEST_ERR_FILE) {
            require('fs').writeFileSync(process.env.TEST_ERR_FILE, '');
        }
        process.stderr.write(`${err.stack}\n`);
        throw err;
    }
}

window.addEventListener('unhandledrejection', function (ev) {
    done(ev.reason);
});

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

export default function() {
    try {
        nw.Window.get().showDevTools();
        runner(http2_client_duplex_bundle, done);
    } catch (ex) {
        done(ex);
    }
}
