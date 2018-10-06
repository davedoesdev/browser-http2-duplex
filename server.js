/*eslint-env node */
import EventEmitter from 'events';
import { randomBytes } from 'crypto';
import { Duplex, Writable } from 'stream';

class ServerDuplex extends Duplex {
    constructor(stream, options) {
        super(options);
        this.stream = stream;
        this.need_chunk = false;
        this.chunks = [];
        this.sink = new Writable(Object.assign({}, options, {
            write: (chunk, encoding, cb) => {
                this.chunks.push({ chunk, cb });
                if (this.need_chunk) {
                    this._read();
                }
            }
        }));
    }

    _read() {
        if (this.chunks.length > 0) {
            this.need_chunk = false;
            const { chunk, cb } = this.chunks.shift();
            if (this.push(chunk)) {
                process.nextTick(() => this._read());
            }
            return cb();
        }
        this.need_chunk = true;
    }

    _write(chunk, encoding, cb) {
        this.stream.write(chunk, encoding, cb);
    }

    _final(cb) {
        this.stream.end(cb);
    }
}

class Http2DuplexServer extends EventEmitter {
    constructor(http2_server, path, options) {
        super();

        this.sessions = new Set();

        http2_server.on('session', session => {
            const duplexes = new Map();

            session.on('close', () => {
                this.sessions.delete(session);
            });

            session.on('stream', (stream, headers) => {
                if (headers[':path'] !== path) {
                    return;
                }

                this.sessions.add(session);

                const method = headers[':method'];

                switch (method) {
                    case 'GET': {
                        const duplex = new ServerDuplex(stream, options);
                        const id = randomBytes(64).toString('base64');
                        duplexes.set(id, duplex);
                        stream.respond({
                            ':status': 200,
                            'http2-duplex-id': id,
                            'Access-Control-Expose-Headers': 'http2-duplex-id',
                            'Content-Type': 'application/octet-stream'
                        });
                        this.emit('duplex', duplex, id, headers);
                        break;
                    }

                    case 'POST': {
                        const id = headers['http2-duplex-id'];
                        const duplex = duplexes.get(id);
                        if (!duplex) {
                            return stream.respond({
                                ':status': 404
                            }, {
                                endStream: true
                            });
                        }
                        if (headers['http2-duplex-end'] === 'true') {
                            duplex.push(null);
                            duplexes.delete(id);
                            return stream.respond({
                                ':status': 200
                            }, {
                                endStream: true
                            });
                        }
                        stream.on('end', () => {
                            stream.respond({
                                ':status': 200
                            }, {
                                endStream: true
                            });
                        });
                        stream.pipe(duplex.sink, { end: false });
                        break;
                    }

                    default: {
                        stream.respond({
                            ':status': 405
                        }, {
                            endStream: true
                        });
                        this.emit('error', new Error(`unknown method: ${method}`));
                        break;
                    }
                }
            });
        });
    }

    async close() {
        for (let session of this.sessions) {
            try {
                session.destroy();
            } catch (ex) {
                this.emit('warning', ex);
            }
        }
    }
}

export default async function (http2_server, path, options) {
    return new Http2DuplexServer(http2_server, path, options);
}
