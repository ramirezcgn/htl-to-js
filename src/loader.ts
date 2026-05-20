import { transpile } from './transpiler/index';
import { parseI18nXml } from './parseI18nXml';
import fs from 'node:fs';

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

  const { i18nPath, i18nFallbackPaths, ...transpileOptions } = this.getOptions ? this.getOptions() : {} as any;

  let i18nDict: Record<string, string> | undefined;
  if (i18nPath) {
    this.addDependency(i18nPath);
    try {
      const xmlContent = fs.readFileSync(i18nPath, 'utf8');
      i18nDict = parseI18nXml(xmlContent);
    } catch (err: any) {
      this.emitWarning(new Error(`[htl-to-js] Could not load i18n file ${i18nPath}: ${err.message}`));
    }
  }

  let i18nFallbackDicts: Record<string, string>[] | undefined;
  if (Array.isArray(i18nFallbackPaths) && i18nFallbackPaths.length) {
    i18nFallbackDicts = [];
    for (const fbPath of i18nFallbackPaths) {
      this.addDependency(fbPath);
      try {
        const xmlContent = fs.readFileSync(fbPath, 'utf8');
        i18nFallbackDicts.push(parseI18nXml(xmlContent));
      } catch (err: any) {
        this.emitWarning(new Error(`[htl-to-js] Could not load i18n fallback file ${fbPath}: ${err.message}`));
      }
    }
    if (!i18nFallbackDicts.length) i18nFallbackDicts = undefined;
  }

  try {
    return transpile(source, { filename: this.resourcePath, ...transpileOptions, i18nDict, i18nFallbackDicts });
  } catch (err: any) {
    this.emitError(
      new Error(`[htl-to-js] ${this.resourcePath}: ${err.message}`)
    );
    return 'module.exports = {};';
  }
}

export = htlLoader;
