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

const HTML_TEST = /\.html$/;
const HTML_SUFFIX = '.html';
const VIRTUAL_PREFIX = '\0htl-to-js:';

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

    resolveId(source: string, importer?: string) {
      if (!source.split('?')[0].endsWith(HTML_SUFFIX)) return null;

      const importerPath = importer?.startsWith(VIRTUAL_PREFIX)
        ? importer.slice(VIRTUAL_PREFIX.length)
        : importer;
      const resolved = path.isAbsolute(source)
        ? source
        : path.resolve(
            importerPath ? path.dirname(importerPath) : process.cwd(),
            source
          );

      if (!shouldTransform(resolved) || !fs.existsSync(resolved)) return null;
      return VIRTUAL_PREFIX + resolved.replace(HTML_TEST, '.htl-js');
    },

    config() {
      const esbuildStubPlugin = {
        name: 'htl-to-js-optimize-deps-stub',
        setup(build: any) {
          build.onLoad({ filter: /\.htl-js$/, namespace: 'html' }, () => ({
            contents: 'module.exports = {};',
            loader: 'js',
          }));
        },
      };
      return {
        optimizeDeps: {
          esbuildOptions: {
            plugins: [esbuildStubPlugin],
          },
        },
      };
    },

    load(this: any, id: string) {
      if (!id.startsWith(VIRTUAL_PREFIX)) return null;
      const filePath = id
        .slice(VIRTUAL_PREFIX.length)
        .replace(/\.htl-js$/, HTML_SUFFIX);
      const source = fs.readFileSync(filePath, 'utf8');

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
          filename: filePath,
          ...transpileOptions,
          i18nDict,
          i18nFallbackDicts,
          format: 'esm',
          sourceURL: false,
        });
        return { code, map: null };
      } catch (err: any) {
        this.error(new Error(`[htl-to-js] ${filePath}: ${err.message}`));
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
