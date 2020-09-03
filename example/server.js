/*eslint-env node */
import fs from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createSecureServer } from 'http2';
import { Http2DuplexServer } from '../server.js';
const { readFile } = fs.promises;
const __dirname = dirname(fileURLToPath(import.meta.url));
const cert_dir = join(__dirname, '..', 'test', 'certs');

(async function () {
    const http2_server = createSecureServer({
        key: await readFile(join(cert_dir, 'server.key')),
        cert: await readFile(join(cert_dir, 'server.crt'))
    });

    const http2_duplex_server = new Http2DuplexServer(
        http2_server,
        '/example'
    );

    http2_duplex_server.on('duplex', function (stream) {
        stream.pipe(stream);
    });

    http2_duplex_server.on('unhandled_stream', function (stream, headers) {
        const path = headers[':path'];
        if (path === '/client.html') {
            return stream.respondWithFile(
                join(__dirname, path.substr(1)),
                { 'content-type': 'text/html' });
        }
        if ((path === '/client.js') ||
            (path === '/bundle.js')) {
            return stream.respondWithFile(
                join(__dirname, path.substr(1)),
                { 'content-type': 'text/javascript' });
        }
        stream.respond({ ':status': 404 }, { endStream: true });
    });

    http2_server.listen(7000, () =>
        console.log('Please visit https://localhost:7000/client.html'));
})();
