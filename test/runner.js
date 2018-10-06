/*eslint-env node, mocha */
import fs from 'fs';
import { join } from 'path';
import { createSecureServer } from 'http2';
import { promisify, callbackify } from 'util';
import { randomBytes } from 'crypto';
import { expect } from 'chai';
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
        let http2_duplex_server;
        let port;

        const client_duplexes = new Map();
        const server_duplexes = new Map();

        before(async function () {
            http2_server = createSecureServer({
                key: await readFile(join(__dirname, 'certs', 'server.key')),
                cert: await readFile(join(__dirname, 'certs', 'server.crt'))
            });

            http2_duplex_server = await make_http2_duplex_server(
                http2_server, '/test');

            http2_duplex_server.on('duplex', (duplex, id) => {
                duplex.on('finish', () => {
                    expect(server_duplexes.has(id)).to.be.true;
                    server_duplexes.delete(id);
                });
                expect(server_duplexes.has(id)).to.be.false;
                duplex.randomBytes = randomBytes;
                server_duplexes.set(id, duplex);
            });

            await promisify(http2_server.listen.bind(http2_server))(0);

            port = http2_server.address().port;
        });

        after(async function () {
            await http2_duplex_server.close();
            await promisify(http2_server.close.bind(http2_server))();
        });

        beforeEach(function () {
            expect(client_duplexes.size).to.equal(0);
            expect(server_duplexes.size).to.equal(0);
        });

        afterEach(function (cb) {
            function check() {
                if ((client_duplexes.size === 0) &&
                    (server_duplexes.size === 0)) {
                    cb();
                }
            }

            for (let d of server_duplexes.values()) {
                d.on('finish', check);
            }

            for (let d of client_duplexes.values()) {
                d.on('end', check);
            }

            check();
        });

        function multiple(n, name, f) {
            it(name, function (cb) {
                function check() {
                    if ((client_duplexes.size !== n) || 
                        (server_duplexes.size !== n)) {
                        return;
                    }

                    let count = 0;

                    function check2(err) {
                        if (err) {
                            return cb(err);
                        }
                        if (++count === n*2) {
                            cb();
                        }
                    }

                    for (let [id, cd] of client_duplexes) {
                        const sd = server_duplexes.get(id);
                        expect(sd).to.exist;
                        f(cd, sd, check2);
                        f(sd, cd, check2);
                    }
                }

                for (let i = 0; i < n; ++i) {
                    callbackify(http2_client_duplex_bundle.make)(
                        `https://localhost:${port}/test`,
                        {},
                        (err, d) => {
                            if (err) {
                                return cb(err);
                            }
                            d.on('end', () => {
                                expect(client_duplexes.has(d.id)).to.be.true;
                                client_duplexes.delete(d.id);
                            });
                            expect(client_duplexes.has(d.id)).to.be.false;
                            d.randomBytes = http2_client_duplex_bundle.crypto.randomBytes;
                            client_duplexes.set(d.id, d);
                            check();
                        });
                }
            });
        }

        // TODO
        // get cleanup working even if test hasn't read/written everything
        // Make this middleware so we know when path not handled?
        // Use random data so we know data is separated

        function tests(n) {
            function test(name, f) {
                multiple(n, `${name} (x${n})`, f);
            }

            test('single byte', function (sender, receiver, cb) {
                let sender_done = false;
                let receiver_done = false;

                function check() {
                    if (sender_done && receiver_done) {
                        cb();
                    }
                }

                const send_buf = sender.randomBytes(1);
                let receive_buf;

                receiver.once('readable', function () {
                    receive_buf = this.read();
                    this.on('readable', function () {
                        expect(this.read()).not.to.exist;
                    });
                });

                receiver.on('end', function () {
                    expect(receive_buf.toString('hex')).to.equal(
                        send_buf.toString('hex'));
                    this.end();
                    receiver_done = true;
                    check();
                });

                sender.end(send_buf, () => {
                    sender_done = true;
                    check();
                });
            });
        }

        tests(1);
    });

    mocha.run(function (failures) {
        done(failures ? new Error('failed') : null);
    });
}
