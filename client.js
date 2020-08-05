/*eslint-env node, browser */
import { Duplex } from 'stream';

export class ResponseError extends Error {
    constructor(response) {
        super(response.statusText || String(response.status));
        this.response = response;
    }
}

class FetchDuplex extends Duplex {
    constructor(url, options) {
        super(options);
        this.url = url;
        this.options = Object.assign({
            disable_request_streaming: false
        }, options);
        this.first = true;
        this.reading = false;
    }

    async init() {
        const response = await fetch(this.url, Object.assign({
            cache: 'no-store'
        }, this.options));
        if (!response.ok) {
            throw new ResponseError(response);
        }
        this.reader = response.body.getReader();
        this.id = response.headers.get('http2-duplex-id');

        if (!this.options.disable_request_streaming && !new Request('', {
            body: new ReadableStream(),
            method: 'POST',
        }).headers.has('Content-Type')) {
            const { readable, writable } = new TransformStream();
            await fetch(this.url, this._write_options({
                headers: {
                    'http2-duplex-single': 'true'
                },
                body: readable
            }));
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
            headers: {}
        }, extra_options, this.options);
        options.headers = Object.assign({
            'http2-duplex-id': this.id,
            'Content-Type': 'application/octet-stream'
        }, options.headers);
        return options;
    }

    async _write(chunk, encoding, cb) {
        try {
            const data = Uint8Array.from(chunk);
            if (this.writer) {
                await this.writer.ready;
                return await this.writer.write(data);
            }
            const response = await fetch(this.url, this._write_options({
                body: data
            }));
            if (!response.ok) {
                throw new ResponseError(response);
            }
            await response.arrayBuffer();
        } catch (ex) {
            return cb(ex);
        }
        cb();
    }

    async _final(cb) {
        try {
            if (this.writer) {
                await this.writer.ready;
                return await this.writer.close();
            }
            const response = await fetch(this.url, this._write_options({
                headers: {
                    'http2-duplex-end': 'true'
                }
            }));
            if (!response.ok) {
                throw new ResponseError(response);
            }
            await response.arrayBuffer();
        } catch (ex) {
            return cb(ex);
        }
        cb();
    }
}

export default async function (url, options) {
    const duplex = new FetchDuplex(url, options);
    await duplex.init();
    return duplex;
}
