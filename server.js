/*eslint-env node */
import EventEmitter from 'events';
import { randomBytes } from 'crypto';
import { Duplex, Writable } from 'stream';

function ex_to_err(obj, method) {
    const orig_method = obj[method];
    obj[method] = function (...args) {
        try {
            orig_method.apply(this, args);
        } catch (ex) {
            obj.emit('error', ex);
        }
    };
}

class ServerDuplex extends Duplex {
    constructor(stream, options) {
        super(options);
        this.stream = stream;
        this.options = options;
        this.need_chunk = false;
        this.chunks = [];
    }

    sink() {
        return new Writable(Object.assign({}, this.options, {
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
        if (this.stream._writableState.ending) {
            return cb();
        }
        this.stream.end(cb);
    }
}

export class Http2DuplexServer extends EventEmitter {
    constructor(http2_server, path, options) {
        super();

        this.http2_server = http2_server;
        this.path = path;
        this.options = options;
        this.sessions = new Set();

        this.common_headers = {
            'Cache-Control': 'max-age=0, no-cache, must-revalidate, proxy-revalidate'
        };

        this.session_listener = this.process_session.bind(this);
        http2_server.on('session', this.session_listener);
    }

    async process_session(session) {
        const duplexes = new Map();

        session.on('close', () => {
            this.sessions.delete(session);
            for (let duplex of duplexes.values()) {
                duplex.push(null);
            }
        });

        session.on('stream', async (stream, headers, flags, raw_headers) => {
            await this.process_stream(
                stream, headers, flags, raw_headers,
                duplexes, { ...this.common_headers });
        });
    }

    async process_stream(stream, headers, flags, raw_headers,
        duplexes, response_headers) {
        if (headers[':path'] !== this.path) {
            this.emit('unhandled_stream', stream, headers, flags, raw_headers,
                duplexes, response_headers);
            return false;
        }

        this.sessions.add(stream.session);

        ex_to_err(stream, 'respond');
        ex_to_err(stream, 'close');

        const method = headers[':method'];

        switch (method) {
            case 'GET': {
                await this.new_stream(stream, headers, flags, raw_headers,
                    duplexes, response_headers);
                break;
            }

            case 'POST': {
                const id = headers['http2-duplex-id'];
                const duplex = duplexes.get(id);
                if (!duplex) {
                    stream.respond({
                        ':status': 404,
                        ...response_headers
                    }, {
                        endStream: true
                    });
                    break;
                }
                if (headers['http2-duplex-end'] === 'true') {
                    duplex.push(null);
                    duplexes.delete(id);
                    stream.respond({
                        ':status': 200,
                        ...response_headers
                    }, {
                        endStream: true
                    });
                    break;
                }
                const on_close = () => {
                    stream.close();
                };
                duplex.on('close', on_close);
                stream.on('close', () => {
                    duplex.removeListener('close', on_close);
                });
                const sink = duplex.sink();
                sink.on('finish', () => {
                    stream.respond({
                        ':status': 200,
                        ...response_headers
                    }, {
                        endStream: true
                    });
                });
                stream.pipe(sink);
                break;
            }

            default: {
                stream.respond({
                    ':status': 405,
                    ...response_headers
                }, {
                    endStream: true
                });
                this.emit('warning', new Error(`unknown method: ${method}`));
                break;
            }
        }

        return true;
    }

    async new_stream(stream, headers, flags, raw_headers,
        duplexes, response_headers) {
        const duplex = new ServerDuplex(stream, this.options);
        const id = randomBytes(64).toString('base64');
        duplexes.set(id, duplex);
        duplex.on('close', () => {
            duplexes.delete(id);
            stream.close();
        });
        stream.respond({
            ':status': 200,
            'http2-duplex-id': id,
            'Access-Control-Expose-Headers': 'http2-duplex-id',
            'Content-Type': 'application/octet-stream',
            ...response_headers
        });
        // Sometimes fetch waits for first byte before resolving
        stream.write('a');
        this.emit('duplex', duplex, id, headers, flags, raw_headers,
            duplexes, response_headers);
        return duplex;
    }

    detach() {
        this.http2_server.removeListener('session', this.session_listener);
        for (let session of this.sessions) {
            session.removeAllListeners('stream');
            try {
                session.destroy();
            } catch (ex) {
                this.emit('warning', ex);
            }
        }
    }
}
