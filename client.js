/*eslint-env node, browser */
import { Duplex } from 'stream';

export const id_header = 'http2-duplex-id';

class FetchDuplex extends Duplex {
    constructor(url, response, options) {
        super(options);
        this.url = url;
        this.reader = response.body.getReader();
        this.id = response.headers.get('http2-duplex-id');
        this.reading = false;
    }

    async _read() {
        if (this.reading) {
            return;
        }
        this.reading = true;

        try {
            const { value, done } = await this.reader.read();
            this.reading = false;
            if (done) {
                return this.push(null);
            }
            if (this.push(Buffer.from(value))) {
                process.nextTick(() => this._read());
            }
        } catch (ex) {
            this.emit('error', ex);
        }
    }

    async _write(chunk, encoding, cb) {
        try {
            const response = await fetch(this.url, {
                method: 'POST',
                headers: {
                    'http2-duplex-id': this.id,
                    'Content-Type': 'application/octet-stream'
                },
                body: Uint8Array.from(chunk)
            });
            await response.arrayBuffer();
        } catch (ex) {
            return cb(ex);
        }
        cb();
    }

    async _final(cb) {
        try {
            const response = await fetch(this.url, {
                method: 'POST',
                headers: {
                    'http2-duplex-id': this.id,
                    'http2-duplex-end': 'true'
                }
            });
            await response.arrayBuffer();
        } catch (ex) {
            return cb(ex);
        }
        cb();
    }
}

export default async function (url, options) {
    return new FetchDuplex(url, await fetch(url, options), options);
}
