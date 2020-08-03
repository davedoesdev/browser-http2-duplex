/*eslint-env node, mocha */
const fs = require('fs');
const { join } = require('path');
const { createSecureServer, connect } = require('http2');
const { promisify, callbackify } = require('util');
const { randomBytes, createHash } = require('crypto');
const { PassThrough } = require('stream');
const { expect } = require('chai');
const Mocha  = require('mocha');
const { Http2DuplexServer} = require('http2-duplex/server.js');

const { readFile, writeFile } = fs.promises;

module.exports = function(http2_client_duplex_bundle, done) {
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

        const warnings = [];

        before(async function () {
            http2_server = createSecureServer({
                key: await readFile(join(__dirname, 'certs', 'server.key')),
                cert: await readFile(join(__dirname, 'certs', 'server.crt'))
            });

            http2_duplex_server = new Http2DuplexServer(
                http2_server,
                '/test', {
                    highWaterMark: 100
                });
            http2_duplex_server.attach(); // check ignores if already attached

            http2_duplex_server.on('duplex', function (duplex, id) {
                this.own_stream(duplex.stream); // check ignores if already owned
                const done = () => {
                    expect(server_duplexes.has(id)).to.be.true;
                    server_duplexes.delete(id);
                    duplex.removeListener('finish', done);
                    duplex.removeListener('close', done);
                };
                duplex.on('finish', done);
                duplex.on('close', done);
                expect(server_duplexes.has(id)).to.be.false;
                duplex.randomBytes = randomBytes;
                duplex.createHash = createHash;
                duplex.PassThrough = PassThrough;
                server_duplexes.set(id, duplex);
            });

            http2_duplex_server.on('unhandled_stream', function (stream) {
                stream.respond({
                    ':status': 404
                }, {
                    endStream: true
                });
            });

            http2_duplex_server.on('warning', function (err) {
                warnings.push(err.message);
            });

            await promisify(http2_server.listen.bind(http2_server))(0);

            port = http2_server.address().port;
        });

        after(async function () {
            expect(warnings).to.eql([]);
            const expected_warnings = [];
            for (let session of http2_duplex_server.sessions) {
                const orig_destroy = session.destroy;
                session.destroy = function () {
                    orig_destroy.call(this);
                    throw new Error('foobar');
                };
                expected_warnings.push('foobar');
            }
            http2_duplex_server.detach();
            http2_duplex_server.detach(); // check ignores if already detached
            expect(warnings).to.eql(expected_warnings);
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
                    warnings.length = 0;
                    cb();
                }
            }

            for (let d of server_duplexes.values()) {
                const check2 = () => {
                    d.removeListener('finish', check2);
                    d.removeListener('close', check2);
                    check();
                };
                d.on('finish', check2);
                d.on('close', check2);
            }

            for (let d of client_duplexes.values()) {
                const check2 = () => {
                    d.removeListener('end', check2);
                    d.removeListener('close', check2);
                    check();
                };
                d.on('end', check2);
                d.on('close', check2);
            }

            check();
        });

        function multiple(n, name, f, options) {
            options = Object.assign({
                it: it,
                simultaneous: true,
                highWaterMark: 100,
                url_suffix: '',
                max: n
            }, options);

            if (n > options.max) {
                return;
            }

            options.it(name, function (cb) {
                const ths = this;

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

                        if (options.simultaneous &&
                            !options.only_browser_to_server) {
                            f.call(ths, cd, sd, check2);
                            f.call(ths, sd, cd, check2);
                        } else {
                            f.call(ths, cd, sd, function (err) {
                                ++count;
                                if (err) {
                                    return cb(err);
                                }
                                if (options.only_browser_to_server) {
                                    return check2();
                                }
                                f.call(ths, sd, cd, check2);
                            });
                        }
                    }
                }

                let err_count = 0;
                function check_err(err) {
                    ++err_count;
                    if (err || err_count === n) {
                        cb(err);
                    }
                }

                for (let i = 0; i < n; ++i) {
                    callbackify(http2_client_duplex_bundle.make)(
                        `https://localhost:${port}/test${options.url_suffix}`, {
                            highWaterMark: options.highWaterMark
                        },
                        (err, d) => {
                            if (err) {
                                if (options.expect_client_err) {
                                    return f.call(ths, err, check_err);
                                }
                                return cb(err);
                            }
                            d.on('end', () => {
                                expect(client_duplexes.has(d.id)).to.be.true;
                                client_duplexes.delete(d.id);
                            });
                            expect(client_duplexes.has(d.id)).to.be.false;
                            d.randomBytes = http2_client_duplex_bundle.crypto.randomBytes;
                            d.createHash = http2_client_duplex_bundle.crypto.createHash;
                            d.PassThrough = http2_client_duplex_bundle.PassThrough;
                            client_duplexes.set(d.id, d);
                            check();
                        });
                }
            });
        }

        function tests(n) {
            function test(name, f, options) {
                multiple(n, `${name} (x${n})`, f, options);
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
                    receiver_done = true;
                    check();
                });

                sender.end(send_buf, function () {
                    sender_done = true;
                    check();
                });
            });

            test('multiple bytes', function (sender, receiver, cb) {
                this.timeout(60 * 1000);

                let sender_done = false;
                let receiver_done = false;

                const send_hash = sender.createHash('sha256');
                const receive_hash = receiver.createHash('sha256');

                receiver.on('readable', function () {
                    let buf;
                    do {
                        buf = this.read();
                        if (buf !== null) {
                            receive_hash.update(buf);
                        }
                    } while (buf !== null);
                });

                function check() {
                    if (sender_done && receiver_done) {
                        cb();
                    }
                }

                receiver.on('end', function () {
                    expect(receive_hash.digest('hex')).to.equal(
                        send_hash.digest('hex'));
                    receiver_done = true;
                    check();
                });

                let remaining = 100 * 1024;

                function send() {
                    const n = Math.min(Math.floor(Math.random() * 201), remaining);
                    const buf = sender.randomBytes(n);
                    
                    send_hash.update(buf);
                    const r = sender.write(buf);
                    remaining -= n;

                    if (remaining === 0) {
                        return sender.end(function () {
                            sender_done = true;
                            check();
                        });
                    }

                    if (r) {
                        return setTimeout(send, Math.floor(Math.random() * 51));
                    }

                    sender.once('drain', send);
                }

                setTimeout(send, 0); 
            });

            test('echo', function (sender, receiver, cb) {
                let sender_ended = false;
                let receiver_ended = false;

                function check() {
                    if (sender_ended && receiver_ended) {
                        cb();
                    }
                }

                sender.on('end', function () {
                    sender_ended = true;
                    check();
                });

                receiver.on('end', function () {
                    receiver_ended = true;
                    check();
                });

                sender.on('readable', function () {
                    let c;
                    do {
                        c = this.read(1);
                        if (c !== null) {
                            if (c.toString() === 's') {
                                this.end();
                            } else {
                                this.write(c);
                            }
                        }
                    } while (c !== null);
                });

                receiver.on('readable', function () {
                    let c;
                    do {
                        c = this.read(1);
                        if (c !== null) {
                            if (c.toString() === 'r') {
                                this.end();
                            } else {
                                this.write(c);
                            }
                        }
                    } while (c !== null);
                });

                sender.write('s');
                receiver.write('r');
            }, {
                only_browser_to_server: true // but both will send
            });

            function write_backpressure(sender, receiver, cb) {
                this.timeout(60 * 1000);

                let sender_done = false;
                let receiver_done = false;

                const send_hash = sender.createHash('sha256');
                const receive_hash = receiver.createHash('sha256');

                let j = 1;

                receiver.on('readable', function () {
                    const read = () => {
                        let buf;
                        do {
                            buf = this.read(j);
                            if (buf !== null) {
                                receive_hash.update(buf);
                                ++j;
                            }
                        } while (buf !== null);
                    };
                    if ((this._readableState.highWaterMark === 50) &&
                        (j === 1)) {
                        // Make data back up so we cover
                        return setTimeout(read, 2000);
                    }
                    read();
                });

                function check() {
                    if (sender_done && receiver_done) {
                        cb();
                    }
                }

                receiver.on('end', function () {
                    expect(receive_hash.digest('hex')).to.equal(
                        send_hash.digest('hex'));
                    receiver_done = true;
                    check();
                });

                const chunks = new Array(100);
                let i = 0;
                let drains = 0;

                for (let ci = 0; ci < chunks.length; ++ci) {
                    chunks[ci] = sender.randomBytes(ci);
                }

                sender.on('drain', function () {
                    ++drains;
                });

                function write() {
                    let ret;
                    do {
                        ret = sender.write(chunks[i]);
                        send_hash.update(chunks[i]);
                        ++i;
                        if ((receiver._readableState.highWaterMark === 50) &&
                            (i === 99)) {
                            // Allow data to back up
                            return setTimeout(write, 1000);
                        }
                    } while ((ret !== false) && (i < chunks.length));

                    if (i < chunks.length) {
                        return sender.once('drain', write);
                    }

                    sender.end(function () {
                        const hwm = sender._writableState.highWaterMark;
                        expect(drains).to.equal(hwm === 50 ? 66 : 34);
                        sender_done = true;
                        check();
                    });
                }

                setTimeout(write, 0);
            }
            
            test('write backpressure', write_backpressure, {
                simultaneous: false
            });

            test('write backpressure (different hwm)', write_backpressure, {
                simultaneous: false,
                highWaterMark: 50
            });

            test('read backpressure', function (sender, receiver, cb) {
                this.timeout(60 * 1000);

                let sender_done = false;
                let receiver_done = false;

                function check() {
                    if (sender_done && receiver_done) {
                        cb();
                    }
                }

                receiver.once('readable', function () {
                    expect(this.read().length).to.equal(101);
                    this.once('readable', function () {
                        expect(this.read().length).to.equal(50);
                        this.once('readable', function () {
                            expect(this.read()).not.to.exist;
                            receiver.end();
                            receiver_done = true;
                            check();
                        });
                    });
                });

                sender.once('drain', function () {
                    expect(this.write(sender.randomBytes(50))).to.be.true;
                    this.end(function () {
                        sender_done = true;
                        check();
                    });
                    this.resume();
                });

                expect(sender.write(sender.randomBytes(101))).to.be.false;
            }, {
                only_browser_to_server: true
            });

            test('flow', function (sender, receiver, cb) {
                this.timeout(60 * 1000);

                let sender_done = false;
                let receiver_done = false;

                const send_hash = sender.createHash('sha256');
                const receive_hash = receiver.createHash('sha256');

                receiver.on('data', function (buf) {
                    receive_hash.update(buf);
                });

                function check() {
                    if (sender_done && receiver_done) {
                        cb();
                    }
                }

                receiver.on('end', function () {
                    expect(receive_hash.digest('hex')).to.equal(
                        send_hash.digest('hex'));
                    receiver_done = true;
                    check();
                });

                let remaining = 100 * 1024;

                function send() {
                    const n = Math.min(Math.floor(Math.random() * 201), remaining);
                    const buf = sender.randomBytes(n);
                    
                    send_hash.update(buf);
                    sender.write(buf);
                    remaining -= n;

                    if (remaining === 0) {
                        return sender.end(function () {
                            sender_done = true;
                            check();
                        });
                    }

                    setTimeout(send, Math.floor(Math.random() * 51));
                }

                setTimeout(send, 0);
            });

            test('pipe', function (sender, receiver, cb) {
                this.timeout(60 * 1000);

                const random_stream = new sender.PassThrough();
                const out_hash = sender.createHash('sha256');
                let remaining = 1024 * 1024;
                while (remaining > 0) {
                    const n = Math.min(Math.floor(Math.random() * 65536), remaining);
                    const buf = sender.randomBytes(n);
                    out_hash.update(buf);
                    random_stream.write(buf);
                    remaining -= n;
                }

                const in_hash = sender.createHash('sha256');
                sender.on('readable', function () {
                    let buf;
                    do {
                        buf = this.read();
                        if (buf !== null) {
                            in_hash.update(buf);
                        }
                    } while (buf !== null);
                });
                sender.on('end', function () {
                    expect(in_hash.digest('hex')).to.equal(
                        out_hash.digest('hex'));
                    cb(); 
                });

                receiver.pipe(receiver);
                random_stream.pipe(sender);
                random_stream.end();
            }, {
                only_browser_to_server: true
            });

            test('emit client read error', function (sender, receiver, cb) {
                const orig_read = sender.reader.read;
                sender.reader.read = function () {
                    throw new Error('foo');
                };

                sender.on('error', function (err) {
                    sender.reader.read = orig_read;
                    process.nextTick(() => this._read());
                    expect(err.message).to.equal('foo');
                    this.on('end', cb);
                    this.end();
                });

                receiver.on('end', function () {
                    this.end();
                });
                receiver.resume();

                sender.resume();
            }, {
                only_browser_to_server: true
            });

            test('emit client write error', function (sender, receiver, cb) {
                const orig_id = sender.id;
                sender.id += 'x';

                sender.on('error', function (err) {
                    sender.id = orig_id;
                    expect(err).to.be.an.instanceof(http2_client_duplex_bundle.ResponseError);
                    expect(err.response.status).to.equal(404);
                    expect(err.message).to.equal('404');
                    this.on('end', cb);
                    this.end();
                });

                receiver.on('end', function () {
                    this.end();
                });
                receiver.resume();

                sender.write('hello');
                sender.resume();
            }, {
                only_browser_to_server: true
            });

            test('emit client end error', function (sender, receiver, cb) {
                const orig_id = sender.id;
                sender.id += 'x';

                sender.on('error', function (err) {
                    sender.id = orig_id;
                    expect(err).to.be.an.instanceof(http2_client_duplex_bundle.ResponseError);
                    expect(err.response.status).to.equal(404);
                    expect(err.message).to.equal('404');
                    this.on('end', cb);
                    this._final(() => {});
                });

                receiver.on('end', function () {
                    this.end();
                });
                receiver.resume();

                sender.end();
                sender.resume();
            }, {
                only_browser_to_server: true
            });

            test('close event', function (sender, receiver, cb) {
                sender.on('readable', function () {
                    while (this.read() !== null);
                });
                sender.on('error', function (err) {
                    expect(err).to.be.an.instanceof(http2_client_duplex_bundle.ResponseError);
                    expect(err.response.status).to.equal(404);
                    expect(err.message).to.equal('404');
                    expect(receiver.stream.closed).to.be.true;
                    cb();
                });
                receiver.destroy();
                sender.end();
            }, {
                only_browser_to_server: true
            });

            test('session close', function (sender, receiver, cb) {
                receiver.on('finish', cb);
                receiver.on('end', function () {
                    this.end();
                });
                receiver.on('readable', function () {
                    while (this.read() !== null);
                });
                sender.on('readable', function () {
                    while (this.read() !== null);
                });
                sender.on('error', function (err) {
                    if (err instanceof http2_client_duplex_bundle.ResponseError) {
                        expect(err.response.status).to.equal(404);
                        expect(err.message).to.equal('404');
                    } else {
                        expect(err.message).to.equal('network error');
                    }
                });
                receiver.stream.session.destroy();
                sender.end();
            }, {
                only_browser_to_server: true,
                max: 1
            });

            test('emit client make error', function (err, cb) {
                expect(err).to.be.an.instanceof(http2_client_duplex_bundle.ResponseError);
                expect(err.response.status).to.equal(404);
                expect(err.message).to.equal('404');
                cb();
            }, {
                only_browser_to_server: true,
                url_suffix: '_does_not_exist',
                expect_client_err: true
            });

            it('unknown method', function (cb) {
                const session = connect(
                    `https://localhost:${port}`, {
                        ca: fs.readFileSync(join(__dirname, 'certs', 'ca.crt'))
                    });
                const stream = session.request({
                    ':method': 'HEAD',
                    ':path': '/test'
                });
                stream.on('response', headers => {
                    expect(headers[':status']).to.equal(405);
                    expect(warnings).to.eql([ 'unknown method: HEAD' ]);
                    session.close(cb);
                });
            });

            it('close active POST request when duplex closes', function (cb) {
                let duplex, headers;
                function next() {
                    if (!duplex || !headers) {
                        return;
                    }
                    duplex.stream.session.once('stream', stream => {
                        stream.on('error', err => {
                            expect(err.code).to.equal('ERR_HTTP2_INVALID_STREAM');
                        });
                    });
                    const stream2 = session.request({
                        ':method': 'POST',
                        ':path': '/test',
                        'http2-duplex-id': headers['http2-duplex-id']
                    });
                    stream2.on('response', () => {
                        cb(new Error('should not be called'));
                    });
                    stream2.on('close', () => {
                        session.close(cb);
                    });
                    setTimeout(() => {
                        duplex.destroy();
                    }, 1000);
                }
                http2_duplex_server.once('duplex', d => {
                    duplex = d;
                    next();
                });
                const session = connect(
                    `https://localhost:${port}`, {
                        ca: fs.readFileSync(join(__dirname, 'certs', 'ca.crt'))
                    });
                const stream = session.request({
                    ':method': 'GET',
                    ':path': '/test'
                });
                stream.on('readable', function () {
                    while (this.read() !== null);
                });
                stream.on('response', function (h) {
                    expect(h[':status']).to.equal(200);
                    headers = h;
                    next();
                });
            });
        }

        tests(1);
        tests(2);
        tests(5);
        tests(10);
    });

    mocha.run(async function (failures) {
        try {
            const coverage_dir = process.env.NYC_OUTPUT_DIR;
            if (coverage_dir) {
                const coverage = Object.assign(global.__coverage__,
                    http2_client_duplex_bundle.window.__coverage__);
                const json = JSON.stringify(coverage);
                await writeFile(join(coverage_dir, 'coverage.json'), json);
            }
        } catch (ex) {
            return done(ex);
        }
        done(failures ? new Error('failed') : null);
    });
};
