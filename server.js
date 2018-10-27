/*eslint-env node */
import EventEmitter from 'events';
import { randomBytes } from 'crypto';
import { Duplex, Writable } from 'stream';

const common_headers = {
    'Cache-Control': 'max-age=0, no-cache, must-revalidate, proxy-revalidate'
};

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
        this.stream.end(cb);
    }
}

class Http2DuplexServer extends EventEmitter {
    constructor(http2_server, path, options) {
        super();

        this.path = path;
        this.options = options;
        this.sessions = new Set();

        http2_server.on('session', session => {
            const duplexes = new Map();

            session.on('close', () => {
                this.sessions.delete(session);
            });

            session.on('stream', async (stream, headers, flags, rawHeaders) => {
                await this.process_stream(stream, headers, flags, rawHeaders, duplexes);
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

    async process_stream(stream, headers, flags, rawHeaders, duplexes) {
        if (headers[':path'] !== this.path) {
            this.emit('unhandled_stream', stream, headers, flags, rawHeaders);
            return false;
        }

        this.sessions.add(stream.session);

        const method = headers[':method'];

        switch (method) {
            case 'GET': {
                const duplex = new ServerDuplex(stream, this.options);
                const id = randomBytes(64).toString('base64');
                duplexes.set(id, duplex);
                stream.respond({
                    ':status': 200,
                    'http2-duplex-id': id,
                    'Access-Control-Expose-Headers': 'http2-duplex-id',
                    'Content-Type': 'application/octet-stream',
                    ...common_headers
                });
                // Sometimes fetch waits for first byte before resolving
                stream.write('a');
                this.emit('duplex', duplex, id, headers);
                break;
            }

            case 'POST': {
                const id = headers['http2-duplex-id'];
                const duplex = duplexes.get(id);
                if (!duplex) {
                    stream.respond({
                        ':status': 404,
                        ...common_headers
                    }, {
                        endStream: true
                    });
                    return true;
                }
                if (headers['http2-duplex-end'] === 'true') {
                    duplex.push(null);
                    duplexes.delete(id);
                    stream.respond({
                        ':status': 200,
                        ...common_headers
                    }, {
                        endStream: true
                    });
                    return true;
                }
                const sink = duplex.sink();
                sink.on('finish', () => {
                    stream.respond({
                        ':status': 200,
                        ...common_headers
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
                    ...common_headers
                }, {
                    endStream: true
                });
                this.emit('warning', new Error(`unknown method: ${method}`));
                break;
            }
        }

        return true;
    }
}

export default async function (http2_server, path, options) {
    return new Http2DuplexServer(http2_server, path, options);
}
