/*eslint-env node */

const webpack = require('webpack');

module.exports = {
    context: __dirname,
    entry: './bundler.js',
    output: {
        filename: 'bundle.js',
        path: __dirname,
        library: 'http2_client_duplex_bundle'
    },
    performance: { hints: false },
    optimization: { minimize: false },
    module: {
        rules: [{
            test: /\.js$/,
            enforce: 'pre',
            use: ['source-map-loader']
        }]
    },
    devtool: 'source-map',
    resolve: {
        fallback: {
            crypto: 'crypto-browserify',
            stream: 'stream-browserify'
        },
        alias: {
            process: 'process/browser'
        }
    },
    plugins: [
        new webpack.ProvidePlugin({
            process: 'process'
        })
    ]
};
