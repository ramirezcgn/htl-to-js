import { transpile } from './transpiler/index';

/**
 * Webpack loader for HTL templates.
 *
 * Configuration (webpack.config.js or .storybook/main.js):
 *
 *   module: {
 *     rules: [{
 *       test: /\.html$/,
 *       include: /jcr_root[\\/]apps/,
 *       use: 'htl-to-js/loader',
 *     }]
 *   }
 *
 * Then in your Storybook stories:
 *
 *   import { createAccordion } from '../path/to/accordion.html';
 */
function htlLoader(this: any, source: string): string {
  this.cacheable(true);

  const options = this.getOptions ? this.getOptions() : {};

  try {
    return transpile(source, { filename: this.resourcePath, ...options });
  } catch (err: any) {
    this.emitError(
      new Error(`[htl-to-js] ${this.resourcePath}: ${err.message}`)
    );
    return 'module.exports = {};';
  }
}

export = htlLoader;
