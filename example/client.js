/*eslint-env browser */
/*global http2_client_duplex_bundle */

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
