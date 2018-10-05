/*eslint-env node, mocha */
import fs from 'fs';
import { join } from 'path';
import { createSecureServer } from 'http2';
import { promisify } from 'util';
import Mocha from 'mocha';
import make_http2_duplex_server from 'browser-http2-duplex/server.js';

const { readFile } = fs.promises;

export default function(http2_client_duplex_bundle, done) {
    const mocha = new Mocha({
        bail: true,
    });
    mocha.suite.emit('pre-require', global, null, mocha);

    describe('Browser HTTP2 full duplex emulation', function () {
        let http2_server;

        before(async function () {
            http2_server = createSecureServer({
                key: await readFile(join(__dirname, 'certs', 'server.key')),
                cert: await readFile(join(__dirname, 'certs', 'server.crt'))
            });

            await promisify(http2_server.listen.bind(http2_server))(0);
        });

        after(async function () {
            // remember to close our http_duplex_server
            await promisify(http2_server.close.bind(http2_server))();
        });

        it('foobar', async function () {
            console.log("FOO");
        });
    });

    mocha.run(function (failures) {
        done(failures ? new Error('failed') : null);
    });
}
