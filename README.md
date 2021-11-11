# The problem

The [HTTP/2 spec](https://httpwg.org/specs/rfc7540.html) supports
full-duplex streams between client and server. Accordingly, if you use
the Node.js
[`http2`](https://nodejs.org/dist/latest-v10.x/docs/api/http2.html)
module on client and server, you get a
[`Duplex`](https://nodejs.org/dist/latest-v10.x/docs/api/stream.html#stream_class_stream_duplex)
stream on both sides.

However, you won’t get a full-duplex stream in a browser client.

The [Fetch](https://fetch.spec.whatwg.org/) API specification does
provide for duplex streams:

  - You can [specify a
    ReadableStream](https://fetch.spec.whatwg.org/#body-mixin) when
    making a request (here’s the
    [PR](https://github.com/whatwg/fetch/pull/425) which added it to the
    spec).

  - You can call `getReader` on [response
    bodies](https://fetch.spec.whatwg.org/#concept-body) to get a
    [`ReadableStream`](https://streams.spec.whatwg.org/#rs-class).

The latter works fine in browsers — you can read data sent from the
server using the `ReadableStream` class.

But streaming data from the browser to the server using Fetch doesn’t
work.

To quote [this
comment](https://bugs.chromium.org/p/chromium/issues/detail?id=688906#c40)
from the Chromium team:

> It won’t be full-duplex. You’ll have to send everything before
> receiving anything (anything sent by the server before that will be
> buffered).

And to quote [this article](https://web.dev/fetch-upload-streaming/)
from a Chrome developer advocate:

> In Chrome’s current implementation, you won’t get the response until
> the body has been fully sent.

Further, it looks like streaming upoad support has now [been
dropped](https://bugs.chromium.org/p/chromium/issues/detail?id=688906#c57):

> Thank you very much for participate in the origin trial. We worked
> with a parter but we failed to show benefits of the feature, so we’re
> giving up shipping the feature.

# Solution

`browser-http2-duplex` emulates a full-duplex Node.js `Duplex` stream in
the browser over HTTP/2 using the Fetch API.

  - Each data chunk your application writes to the `Duplex` is sent to
    the server in a *separate* POST request (over a single HTTP/2
    connection).

  - Data from the initial response body’s `ReadableStream` is pushed to
    the `Duplex` for your application to read.

On the server, `browser-http2-duplex` marries up the separate POST
requests with the initial reponse and presents a `Duplex` stream to your
application.

UPDATE: The new [WebTransport](https://www.w3.org/TR/webtransport/) W3C
standard supports bidirectional streams between browser and server. If
you can live with HTTP/3 only then you might want to check it out.

# Example

Here’s a server which echoes data it receives on a duplex stream back to
clients.

**server.js.**

``` javascript
import fs from 'fs';
import { join } from 'path';
import { createSecureServer } from 'http2';
import { Http2DuplexServer } from 'http2-duplex';
const { readFile } = fs.promises;
const cert_dir = join(__dirname, 'certs');

(async function () {
    const http2_server = createSecureServer({ // 
        key: await readFile(join(cert_dir, 'server.key')),
        cert: await readFile(join(cert_dir, 'server.crt'))
    });

    const http2_duplex_server = new Http2DuplexServer( // 
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
```

  - Create a standard Node.js HTTP/2 server.

  - Create a server to communicate with clients using full-duplex
    emulation.

  - When a client creates a new duplex, the server gets a `duplex`
    event.

  - Other requests raise an `unhandled_stream` event. Here we return the
    client files to the browser.

Note you can just Control-C the server to stop it. If you wanted to stop
the server in code, you would do something like this:

``` javascript
http2_duplex_server.detach(); 
await promisify(http2_server.close.bind(http2_server))();
```

  - This destroys all active sessions.

Here’s a client which sends keypresses to the server and writes the
echoed response to the page:

**client.js.**

``` javascript
export default async function () {
    const duplex = await http2_client_duplex_bundle.make( 
        'https://localhost:7000/example');

    document.addEventListener('keypress', ev => { 
        duplex.write(ev.key);
    });

    duplex.on('readable', function () { 
        let buf;
        do {
            buf = this.read();
            if (buf !== null) {
                document.body.appendChild(document.createTextNode(buf.toString()));
            }
        } while (buf !== null);
    });
}
```

  - Connect to the server and emulate a new full-duplex stream.

  - When the user presses a key, write the character to the stream.

  - Read characters the server echoes back from the stream and append
    them to the document body.

That’s a simple example of setting up duplex emulation between a browser
and a server. You’ll also need an HTML page and to bundle up the
client-side library (e.g. using Webpack). You can find all these files
in the [example](example) directory. To run the example:

``` bash
grunt --gruntfile Gruntfile.cjs example
```

and then point your browser to <https://localhost:7000/client.html>.

# Installation

``` bash
npm install http2-duplex
```

# Licence

[MIT](LICENCE)

# Test

``` bash
grunt --gruntfile Gruntfile.cjs test
```

# Lint

``` bash
grunt --gruntfile Gruntfile.cjs lint
```

# Coverage

``` bash
grunt --gruntfile Gruntfile.cjs coverage
```

[Istanbul](https://istanbul.js.org/) results are available
[here](http://rawgit.davedoesdev.com/davedoesdev/browser-http2-duplex/master/coverage/lcov-report/index.html).

Coveralls page is
[here](https://coveralls.io/r/davedoesdev/browser-http2-duplex).
