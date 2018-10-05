/*eslint-env node */

import unused_mocha from 'mocha';

export default function (grunt) {
    grunt.initConfig({
        eslint: {
            target: [
                '*.js',
                'test/**/*.js',
                '!test/bundle.js',
                '!test/node_modules/**/*.js'
            ]
        },

        exec: {
            bundle: './node_modules/.bin/webpack -r esm --mode production --config test/webpack.config.js',
            nw_build: [
                'rsync -a node_modules test --exclude nw-builder',
                'mkdir -p test/node_modules/browser-http2-duplex',
                'cp server.js test/node_modules/browser-http2-duplex',
                './node_modules/.bin/nwbuild --quiet -p linux64 test',
            ].join('&&'),
            test: 'export TEST_ERR_FILE=/tmp/test_err_$$; ./build/http2-duplex-test/linux64/http2-duplex-test; if [ -f $TEST_ERR_FILE ]; then exit 1; fi'
        }
    });

    grunt.loadNpmTasks('grunt-eslint');
    grunt.loadNpmTasks('grunt-exec');
    
    grunt.registerTask('lint', 'eslint');
    grunt.registerTask('test', [
        'exec:bundle',
        'exec:nw_build',
        'exec:test'
    ]);
}
