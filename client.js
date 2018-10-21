/*eslint-env node, browser */
import { Duplex } from 'stream';

export const id_header = 'http2-duplex-id';

export class ResponseError extends Error {
    constructor(response) {
        super(response.statusText);
        this.response = response;
    }
}

class FetchDuplex extends Duplex {
    constructor(url, response, options) {
        super(options);
        this.url = url;
        this.reader = response.body.getReader();
        this.id = response.headers.get('http2-duplex-id');
        this.options = options;
        this.first = true;
    }

    async _read() {
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
                } else {
                    done = !this.push(Buffer.from(value));
                }
            } while (!done);
        } catch (ex) {
            this.emit('error', ex);
        }
    }

    async _write(chunk, encoding, cb) {
        try {
            const options = Object.assign({
                method: 'POST',
                body: Uint8Array.from(chunk),
                cache: 'no-store',
                headers: {}
            }, this.options);
            options.headers = Object.assign({
                'http2-duplex-id': this.id,
                'Content-Type': 'application/octet-stream'
            }, options.headers);
            const response = await fetch(this.url, options);
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
            const options = Object.assign({
                method: 'POST',
                cache: 'no-store',
                headers: {}
            }, this.options);
            options.headers = Object.assign({
                'http2-duplex-id': this.id,
                'http2-duplex-end': 'true'
            }, options.headers);
            const response = await fetch(this.url, options);
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
    const response = await fetch(url, Object.assign({
        cache: 'no-store'
    }, options));
    if (!response.ok) {
        throw new ResponseError(response);
    }
    return new FetchDuplex(url, response, options);
}
