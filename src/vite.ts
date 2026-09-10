import { transpile } from './transpiler/index';
import { parseI18nXml } from './parseI18nXml';
import fs from 'node:fs';
import path from 'node:path';

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface HtlVitePluginOptions {
  /** Restrict transform to matching ids. Defaults to every `.html` file. */
  include?: MatchPattern;
  exclude?: MatchPattern;
  i18nPath?: string;
  i18nFallbackPaths?: string[];
  omitAttrs?: RegExp[];
  wrapperClass?: string | boolean;
  resourceWrappers?: Record<
    string,
    string | { wrapper?: string; childClass?: string }
  >;
  resourceDecorations?: Record<
    string,
    { decorationTagName?: string; cssClassName?: string; decoration?: boolean }
  >;
  fileOverrides?: Record<
    string,
    string | { expression?: string; htl?: string }
  >;
  modelTransforms?: Record<string, Record<string, any>>;
  usePathCaching?: boolean;
}

const HTML_SUFFIX = '.html';

type MatchPattern = RegExp | string | (RegExp | string)[];

function toMatcher(pattern?: MatchPattern): ((id: string) => boolean) | null {
  if (!pattern) return null;
  const patterns = Array.isArray(pattern) ? pattern : [pattern];
  return (id: string) =>
    patterns.some((p) => (p instanceof RegExp ? p.test(id) : id.includes(p)));
}

export function htlPlugin(options: HtlVitePluginOptions = {}) {
  const { include, exclude, i18nPath, i18nFallbackPaths, ...transpileOptions } =
    options;

  const includeMatch = toMatcher(include);
  const excludeMatch = toMatcher(exclude);

  function shouldTransform(id: string): boolean {
    if (!id.endsWith(HTML_SUFFIX)) return false;
    if (excludeMatch?.(id)) return false;
    if (includeMatch) return includeMatch(id);
    return true;
  }

  const watchPaths = [i18nPath, ...(i18nFallbackPaths ?? [])].filter(
    Boolean
  ) as string[];

  return {
    name: 'htl-to-js',
    enforce: 'pre' as const,

    transform(this: any, source: string, id: string) {
      if (!shouldTransform(id)) return null;

      let i18nDict: Record<string, string> | undefined;
      if (i18nPath) {
        this.addWatchFile(i18nPath);
        try {
          i18nDict = parseI18nXml(fs.readFileSync(i18nPath, 'utf8'));
        } catch (err: any) {
          this.warn(
            `[htl-to-js] Could not load i18n file ${i18nPath}: ${err.message}`
          );
        }
      }

      let i18nFallbackDicts: Record<string, string>[] | undefined;
      if (Array.isArray(i18nFallbackPaths) && i18nFallbackPaths.length) {
        i18nFallbackDicts = [];
        for (const fbPath of i18nFallbackPaths) {
          this.addWatchFile(fbPath);
          try {
            i18nFallbackDicts.push(
              parseI18nXml(fs.readFileSync(fbPath, 'utf8'))
            );
          } catch (err: any) {
            this.warn(
              `[htl-to-js] Could not load i18n fallback file ${fbPath}: ${err.message}`
            );
          }
        }
        if (!i18nFallbackDicts.length) i18nFallbackDicts = undefined;
      }

      try {
        const code = transpile(source, {
          filename: id,
          ...transpileOptions,
          i18nDict,
          i18nFallbackDicts,
          format: 'esm',
          sourceURL: false,
        });
        return { code, map: null };
      } catch (err: any) {
        this.error(new Error(`[htl-to-js] ${id}: ${err.message}`));
      }
    },

    // Dev-server-only: i18n files aren't part of the module graph, so a
    // plain addWatchFile won't trigger HMR for them while `vite dev` is
    // running — reload manually when they change.
    configureServer(server: any) {
      if (!watchPaths.length) return;
      server.watcher.add(watchPaths);
      server.watcher.on('change', (file: string) => {
        if (watchPaths.includes(path.resolve(file))) {
          server.ws.send({ type: 'full-reload' });
        }
      });
    },
  };
}
