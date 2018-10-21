/*eslint-env node */

import { join } from 'path';
import unused_mocha from 'mocha';

const coverage_dir = join(__dirname, '.nyc_output');

export default function (grunt) {
    grunt.initConfig({
        eslint: {
            target: [
                '*.js',
                'test/**/*.js',
                '!test/client.js',
                '!test/server.js',
                '!test/bundle.js',
                '!test/node_modules/**/*.js',
                'example/**/*.js',
                '!example/bundle.js'
            ]
        },

        exec: {
            bundle: './node_modules/.bin/webpack -r esm --mode production --config test/webpack.config.js',
            nw_build: [
                'rsync -a node_modules test --exclude nw-builder',
                'mkdir -p test/node_modules/browser-http2-duplex',
                'cp test/server.js test/node_modules/browser-http2-duplex',
                './node_modules/.bin/nwbuild --quiet -p linux64 test',
                'sync'
            ].join('&&'),
            test: 'export TEST_ERR_FILE=/tmp/test_err_$$; ./build/http2-duplex-test/linux64/http2-duplex-test; if [ -f $TEST_ERR_FILE ]; then exit 1; fi',
            instrument: {
                cmd: './node_modules/.bin/babel client.js server.js --out-dir test',
                options: {
                    env: Object.assign({}, process.env, {
                        NODE_ENV: 'test'
                    })
                }
            },
            cover: {
                cmd: [
                    `mkdir -p '${coverage_dir}'`,
                    './node_modules/.bin/grunt test'
                ].join('&&'),
                options: {
                    env: Object.assign({}, process.env, {
                        NYC_OUTPUT_DIR: coverage_dir
                    })
                }
            },
            cover_report: './node_modules/.bin/nyc report -r lcov',
            cover_check: './node_modules/.bin/nyc check-coverage --statements 100 --branches 100 --functions 100 --lines 100',
            coveralls: 'cat coverage/lcov.info | coveralls',
            example: [
                './node_modules/.bin/webpack -r esm --mode production --config example/webpack.config.js',
                'node -r esm example/server.js'
            ].join('&&')
        }
    });

    grunt.loadNpmTasks('grunt-eslint');
    grunt.loadNpmTasks('grunt-exec');
    
    grunt.registerTask('lint', 'eslint');
    grunt.registerTask('test', [
        'exec:instrument',
        'exec:bundle',
        'exec:nw_build',
        'exec:test'
    ]);
    grunt.registerTask('coverage', [
        'exec:cover',
        'exec:cover_report',
        'exec:cover_check'
    ]);
    grunt.registerTask('coveralls', 'exec:coveralls');
    grunt.registerTask('example', 'exec:example');
}
