/*eslint-env node, browser */
/*global http2_client_duplex_bundle */

const util = require('util');
const os = require('os');

function done(err) {
    if (err) {
        process.stderr.write(`${err.stack}\n`);
    } else if (process.env.TEST_ERR_FILE) {
        require('fs').unlinkSync(process.env.TEST_ERR_FILE);
    }
    require('nw.gui').App.quit();
    if (err) {
        throw err;
    }
}

window.addEventListener('unhandledrejection', function (ev) {
    done(ev.reason);
});

window.onerror = function (message, source, lineno, colno, err) {
    done(err);
};

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
    if (process.env.TEST_ERR_FILE) {
        require('fs').writeFileSync(process.env.TEST_ERR_FILE, '');
    }
    try {
        //nw.Window.get().showDevTools();
        require('./load_runner.cjs')(http2_client_duplex_bundle, done);
    } catch (ex) {
        done(ex);
    }
}
