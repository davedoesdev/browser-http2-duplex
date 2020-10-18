/*eslint-env node, browser */
/* global TransformStream */
import stream from 'stream';
import buffer from 'buffer';
const { Duplex } = stream;
const { Buffer } = buffer;

export class ResponseError extends Error {
    constructor(response) {
        super(response.statusText || String(response.status));
        this.response = response;
    }
}

class FetchDuplex extends Duplex {
    constructor(url, options) {
        super(Object.assign({
            autoDestroy: true
        }, options));
        this.url = url;
        this.options = Object.assign({
            disable_request_streaming: false,
            ResponseError
        }, options);
        this.first = true;
        this.reading = false;
        this.abort_reader = new AbortController();
        this.abort_writer = new AbortController();
    }

    async init() {
        const response = await fetch(this.url, Object.assign({
            cache: 'no-store',
            signal: this.abort_reader.signal
        }, this.options));
        if (!response.ok) {
            throw new this.options.ResponseError(response);
        }
        this.reader = response.body.getReader();
        this.id = response.headers.get('http2-duplex-id');

        if (!this.options.disable_request_streaming && !new Request('', {
            body: new ReadableStream(),
            method: 'POST',
        }).headers.has('Content-Type')) {
            const { readable, writable } = new TransformStream();
            fetch(this.url, this._write_options({
                headers: {
                    'http2-duplex-single': 'true'
                },
                body: readable
            })).then(response => {
                if (!response.ok) {
                    this.destroy(new this.options.ResponseError(response));
                }
            }).catch(err => this.destroy(err));
            this.writer = writable.getWriter();
        }
    }

    async _read() {
        if (this.reading) {
            return;
        }
        this.reading = true;
        try {
            let value, done;
            do {
                ({ value, done } = await this.reader.read());
                if (done) {
                    this.push(null);
                } else if (this.first) {
                    // Sometimes fetch waits for first byte before resolving
                    // so server-side sends initial dummy byte
                    this.first = false;
                    done = !this.push(Buffer.from(value.subarray(1)));
                } else {
                    done = !this.push(Buffer.from(value));
                }
            } while (!done);
        } catch (ex) {
            this.push(null);
            this.emit('error', ex);
        } finally {
            this.reading = false;
        }
    }

    _write_options(extra_options) {
        const options = Object.assign({
            method: 'POST',
            cache: 'no-store',
            signal: this.abort_writer.signal
        }, extra_options, this.options);
        options.headers = Object.assign({
            'http2-duplex-id': this.id,
            'Content-Type': 'application/octet-stream'
        }, extra_options.headers, options.headers);
        return options;
    }

    async _write(chunk, encoding, cb) {
        try {
            const data = Uint8Array.from(chunk);
            if (this.writer) {
                await this.writer.ready;
                await this.writer.write(data);
            } else {
                const response = await fetch(this.url, this._write_options({
                    body: data
                }));
                if (!response.ok) {
                    throw new this.options.ResponseError(response);
                }
                await response.arrayBuffer();
            }
        } catch (ex) {
            return cb(ex);
        }
        cb();
    }

    async _final(cb) {
        try {
            if (this.writer) {
                await this.writer.ready;
                await this.writer.close();
            } else {
                const response = await fetch(this.url, this._write_options({
                    headers: {
                        'http2-duplex-end': 'true'
                    },
                    signal: undefined
                }));
                if (!response.ok) {
                    throw new this.options.ResponseError(response);
                }
                await response.arrayBuffer();
            }
        } catch (ex) {
            return cb(ex);
        }
        cb();
    }

    _destroy(err, cb) {
        const ignore_error = () => {}; // ignore cancel/abort errors
        if (this.reader) {
            this.reader.cancel().catch(ignore_error);
        } else {
            this.abort_reader.abort();
        }
        if (this.writer) {
            this.writer.abort().catch(ignore_error);
            cb(err);
        } else {
            this.abort_writer.abort();
            this._final(() => {}); // don't care if we can't tell other end
            cb(err);
        }
    }
}

export default async function (url, options) {
    const duplex = new FetchDuplex(url, options);
    try {
        await duplex.init();
    } catch (ex) {
        duplex.destroy();
        throw ex;
    }
    return duplex;
}
