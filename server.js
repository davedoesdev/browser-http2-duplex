/*eslint-env node */
import EventEmitter from 'events';
import { randomBytes } from 'crypto';
import { Duplex, Writable } from 'stream';
import { constants } from 'http2';

function ex_to_err(obj, method, check) {
    const orig_method = obj[method];
    obj[method] = function (...args) {
        if (check && check.call(this)) {
            return;
        }
        try {
            orig_method.apply(this, args);
        } catch (ex) {
            obj.emit('error', ex);
        }
    };
}

function ignore_reset_code() {
    Object.defineProperty(this, 'rstCode', {
        get() {
            return constants.NGHTTP2_NO_ERROR;
        },
        configurable: true
    });
}

class ServerDuplex extends Duplex {
    constructor(stream, options) {
        super(options);
        this.stream = stream;
        this.options = options;
        this.need_chunk = false;
        this.chunks = [];
        this.forward_errors(stream);
    }

    forward_errors(stream) {
        stream.on('error', err => {
            this.emit('error', err);
        });
    }

    push_next() {
        const { chunk, cb } = this.chunks.shift();
        process.nextTick(cb);
        return this.push(chunk);
    }

    sink(stream) {
        const ths = this;
        const r = new Writable(Object.assign({}, this.options, {
            write(chunk, encoding, cb) {
                ths.chunks.push({ chunk, cb });
                this.emit('written', chunk.length);
                if (ths.need_chunk) {
                    ths._read();
                }
            }
        }));
        stream.pipe(r);
        return r;
    }

    drain_and_end() {
        while (this.chunks.length > 0) {
            this.push_next();
        }
        this.push(null);
    }

    _read() {
        this.need_chunk = this.chunks.length === 0;
        if (!this.need_chunk) {
            while (this.chunks.length > 0) {
                if (!this.push_next()) {
                    return;
                }
            }
            this.need_chunk = true;
        }
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

    _destroy(err, cb) {
        this.stream.destroy(err);
        cb(err);
    }
}

export class Http2DuplexServer extends EventEmitter {
    constructor(http2_server, path, options) {
        super();

        this.http2_server = http2_server;
        this.path = path;
        this.options = Object.assign({
            close_timeout: 1000,
            autoDestroy: true
        }, options);
        this.sessions = new Set();

        this.common_headers = {
            'Cache-Control': 'max-age=0, no-cache, must-revalidate, proxy-revalidate'
        };

        this.attach();
    }

    attach() {
        if (!this.session_listener) {
            this.session_listener = this.process_session.bind(this);
            this.http2_server.on('session', this.session_listener);
        }
    }

    async process_session(session) {
        const duplexes = new Map();

        this.sessions.add(session);

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

    own_stream(stream) {
        if (!stream.http2_duplex_owned) {
            ex_to_err(stream, 'respond', function () {
                return this.closed || this.destroyed;
            });
            ex_to_err(stream, 'close');
            stream.on('aborted', ignore_reset_code);
            stream.http2_duplex_owned = true;
        }
    }

    async process_stream(stream, headers, flags, raw_headers,
        duplexes, response_headers) {
        if (headers[':path'] !== this.path) {
            this.emit('unhandled_stream', stream, headers, flags, raw_headers,
                duplexes, response_headers);
            return false;
        }

        this.own_stream(stream);

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

                duplex.forward_errors(stream);

                let responded = false;
                const respond = () => {
                    if (!responded) {
                        responded = true;
                        ignore_reset_code.call(stream);
                        stream.respond({
                            ':status': 200,
                            ...response_headers
                        }, {
                            endStream: true
                        });
                    }
                };

                const on_close = () => {
                    respond();
                    const timeout = setTimeout(() => stream.close(), this.options.close_timeout);
                    stream.on('close', () => clearTimeout(timeout));
                };
                duplex.on('close', on_close);
                stream.on('close', () => duplex.removeListener('close', on_close));

                const end = () => {
                    duplex.drain_and_end();
                    duplexes.delete(id);
                    respond();
                };

                if (headers['http2-duplex-end'] === 'true') {
                    end();
                    if (headers['http2-duplex-destroyed'] === 'true') {
                        duplex.stream.close();
                    }
                    break;
                }

                // Note: http2 streams always emit 'end' when they close.
                // See onStreamClose() and _destroy() in lib/internal/http2/core.js

                if (headers['http2-duplex-single'] === 'true') {
                    duplex.sink(stream).on('finish', end);
                    break;
                }

                const content_length = parseInt(headers['content-length'], 10);
                if (content_length === 0) {
                    respond();
                } else {
                    const sink = duplex.sink(stream);
                    sink.on('finish', respond);
                    if (content_length > 0) {
                        let received = 0;
                        sink.on('written', len => {
                            received += len;
                            if (received >= content_length) {
                                stream.push(null);
                            }
                        });
                    }
                }

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
        ex_to_err(duplex, 'end');
        const on_close = () => {
            duplex.end();
        };
        stream.on('close', on_close);
        duplex.on('close', () => {
            stream.removeListener('close', on_close);
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

    destroy(obj) {
        try {
            obj.destroy();
        } catch (ex) {
            this.emit('warning', ex);
        }
    }

    detach() {
        if (this.session_listener) {
            this.http2_server.removeListener('session', this.session_listener);
            this.session_listener = null;
            for (let session of this.sessions) {
                session.removeAllListeners('stream');
                this.destroy(session);
            }
        }
    }
}
