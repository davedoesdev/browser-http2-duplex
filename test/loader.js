/*eslint-env node */
/*global nw, http2_client_duplex_bundle */

const runner = require('./load_runner.js');

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

export default function() {
    try {
        nw.Window.get().showDevTools();
        runner(http2_client_duplex_bundle, done);
    } catch (ex) {
        done(ex);
    }
}
