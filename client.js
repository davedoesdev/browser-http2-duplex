/*eslint-env node, browser */
import stream from 'stream';
import buffer from 'buffer';
const { Duplex } = stream;
const { Buffer } = buffer;

export class ResponseError extends Error {
    constructor(response) {
        super(response.statusText || String(response.status));
        this.response = response;
    }

    async init() {}
}

function request_streaming_supported() {
    let duplex_accessed = false;

    const has_content_type = new Request('', {
        body: new ReadableStream(),
        method: 'POST',
        get duplex() {
            duplex_accessed = true;
            return 'half';
        }
    }).headers.has('Content-Type');

    return duplex_accessed && !has_content_type;
}

class FetchDuplex extends Duplex {
    constructor(url, options) {
        super(Object.assign({
            autoDestroy: true
        }, options));
        this.url = url;
        this.options = Object.assign({
            disable_request_streaming: false,
            fetch: (...args) => fetch(...args),
            ResponseError
        }, options);
        this.first = true;
        this.reading = false;
        this.abort_reader = new AbortController();
        this.abort_writer = new AbortController();
    }

    async _response_error(response) {
        const err = new this.options.ResponseError(response);
        await err.init();
        return err;
    }

    async init() {
        const response = await this.options.fetch(this.url, Object.assign({
            cache: 'no-store',
            signal: this.abort_reader.signal
        }, this.options));
        if (!response.ok) {
            throw await this._response_error(response);
        }
        this.reader = response.body.getReader();
        this.id = response.headers.get('http2-duplex-id');
        if (!this.options.disable_request_streaming && request_streaming_supported()) {
            const { readable, writable } = new TransformStream();
            this.options.fetch(this.url, this._write_options({
                headers: {
                    'http2-duplex-single': 'true'
                },
                body: readable,
                duplex: 'half'
            })).then(async response => {
                if (response.ok) {
                    return this.end();
                }
                this.destroy(await this._response_error(response));
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
        let err;
        try {
            const data = Uint8Array.from(chunk);
            if (this.writer) {
                await this.writer.ready;
                await this.writer.write(data);
            } else {
                const response = await this.options.fetch(this.url, this._write_options({
                    body: data
                }));
                if (!response.ok) {
                    throw await this._response_error(response);
                }
                await response.arrayBuffer();
            }
        } catch (ex) {
            err = ex;
        }
        cb(err);
    }

    async _send_end(err, cb) {
        if (this.id !== undefined) {
            try {
                const response = await this.options.fetch(this.url, this._write_options({
                    headers: {
                        'http2-duplex-end': 'true',
                        'http2-duplex-destroyed': this.destroyed
                    },
                    signal: undefined
                }));
                if (!response.ok) {
                    throw await this._response_error(response);
                }
                await response.arrayBuffer();
            } catch (ex) {
                return cb(err || ex);
            }
        }
        cb(err);
    }

    async _final(cb) {
        if (!this.writer) {
            return await this._send_end(null, cb);
        }
        try {
            await this.writer.ready;
            await this.writer.close();
        } catch (ex) {
            return await this._send_end(ex, cb);
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
        } else {
            this.abort_writer.abort();
            this.abort_writer = new AbortController();
        }
        this._send_end(null, () => {}); // don't care if we can't tell other end
        cb(err);
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
