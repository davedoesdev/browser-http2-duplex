/*eslint-env node */
module.exports = {
    context: __dirname,
    entry: './bundler.js',
    output: {
        filename: 'bundle.js',
        path: __dirname,
        library: 'http2_client_duplex_bundle'
    }
};
