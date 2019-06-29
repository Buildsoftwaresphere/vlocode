const merge = require('webpack-merge').smart;
const common = require('./webpack.common.js');
const TerserPlugin = require('terser-webpack-plugin');

const minimizerOptions = {
    ecma: 6,
    warnings: true,
    parse: {},
    compress: {
        dead_code: false,
        inline: false
    },
    mangle: false,
    module: true,
    keep_classnames: true,
    keep_fnames: true
}

const prodModeConfig = {
    mode: 'production',
    devtool: 'none',
    optimization: {
        mergeDuplicateChunks: true,
        minimizer: [new TerserPlugin({terserOptions: minimizerOptions})]
    }
}

module.exports = [
    merge(common.extension, prodModeConfig),
    merge(common.tests, prodModeConfig),
    merge(common.views, prodModeConfig)
];