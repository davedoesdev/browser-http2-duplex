/*eslint-env node */
export default {
    context: __dirname,
    entry: './bundler.js',
    output: {
        filename: 'bundle.js',
        path: __dirname,
        library: 'http2_client_duplex_bundle'
    }
};
