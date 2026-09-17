import fs from 'node:fs';
import path from 'node:path';
import { htlPlugin } from '../src/vite';

const toVirtualId = (realPath: string) =>
  `\0htl-to-js:${realPath.replace(/\.html$/, '.htl-js')}`;

// Build a minimal fake Rollup/Vite plugin context.
function makeCtx() {
  const warnings: string[] = [];
  const watched: string[] = [];
  const errors: Error[] = [];
  return {
    addWatchFile: (f: string) => watched.push(f),
    warn: (m: string) => warnings.push(m),
    error(e: Error): never {
      errors.push(e);
      throw e;
    },
    get warnings() {
      return warnings;
    },
    get watched() {
      return watched;
    },
    get errors() {
      return errors;
    },
  };
}

describe('htlPlugin', () => {
  let tmpDir: string;
  let cardHtml: string;
  let brokenHtml: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'htl-vite-'));
    fs.mkdirSync(path.join(tmpDir, 'apps', 'mysite', 'card'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(tmpDir, 'apps', 'mysite', 'broken'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(tmpDir, 'apps', 'othersite'), { recursive: true });

    cardHtml = path.join(tmpDir, 'apps', 'mysite', 'card', 'card.html');
    fs.writeFileSync(cardHtml, '<div>${model.title}</div>');

    brokenHtml = path.join(tmpDir, 'apps', 'mysite', 'broken', 'broken.html');
    fs.writeFileSync(brokenHtml, '<div>${model.title}</div>');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('has the expected plugin shape', () => {
    const plugin = htlPlugin();
    expect(plugin.name).toBe('htl-to-js');
    expect(plugin.enforce).toBe('pre');
  });

  it('resolveId ignores non-.html specifiers', () => {
    const plugin = htlPlugin();
    expect(plugin.resolveId('./card.js', cardHtml)).toBeNull();
  });

  it('resolveId ignores specifiers outside of include', () => {
    const plugin = htlPlugin({
      include: path.join(tmpDir, 'apps', 'othersite'),
    });
    expect(plugin.resolveId('./card.html', cardHtml)).toBeNull();
  });

  it('resolveId ignores specifiers matching exclude', () => {
    const plugin = htlPlugin({ exclude: /\.stories\.html$/ });
    const storyHtml = path.join(
      tmpDir,
      'apps',
      'mysite',
      'card',
      'card.stories.html'
    );
    fs.writeFileSync(storyHtml, '<div></div>');
    const importer = path.join(
      tmpDir,
      'apps',
      'mysite',
      'card',
      'card.stories.js'
    );
    expect(plugin.resolveId('./card.stories.html', importer)).toBeNull();
  });

  it('resolveId ignores a specifier that does not resolve to a real file', () => {
    const plugin = htlPlugin();
    const importer = path.join(tmpDir, 'apps', 'mysite', 'card', 'index.js');
    expect(plugin.resolveId('./does-not-exist.html', importer)).toBeNull();
  });

  it('resolveId returns a virtual (null-byte) id that no longer ends in .html', () => {
    const plugin = htlPlugin();
    const importer = path.join(tmpDir, 'apps', 'mysite', 'card', 'index.js');
    const resolved = plugin.resolveId('./card.html', importer);
    expect(resolved?.endsWith('.html')).toBe(false);
    expect(resolved).toBe(toVirtualId(cardHtml));
  });

  it('load ignores ids it did not resolve', () => {
    const plugin = htlPlugin();
    const ctx = makeCtx();
    expect(plugin.load.call(ctx, cardHtml)).toBeNull();
  });

  it('load transpiles the resolved virtual id to ESM output with no source map', () => {
    const plugin = htlPlugin();
    const ctx = makeCtx();
    const result = plugin.load.call(ctx, toVirtualId(cardHtml));
    expect(result?.code).toContain('export { createCard }');
    expect(result?.map).toBeNull();
  });

  it('watches the i18n file and reports parse failures as warnings', () => {
    const plugin = htlPlugin({ i18nPath: '/does/not/exist.xml' });
    const ctx = makeCtx();
    plugin.load.call(ctx, toVirtualId(cardHtml));
    expect(ctx.watched).toContain('/does/not/exist.xml');
    expect(ctx.warnings[0]).toContain('Could not load i18n file');
  });

  it('on transpile error: reports via this.error() with the file path', () => {
    const plugin = htlPlugin({
      fileOverrides: {
        'missing-template.html': { htl: '<div>no template here</div>' },
      },
    });
    const ctx = makeCtx();
    expect(() => plugin.load.call(ctx, toVirtualId(brokenHtml))).toThrow(
      /broken\.html/
    );
    expect(ctx.errors).toHaveLength(1);
  });

  it('load watches the source .html file itself, so Vite knows the virtual module depends on it', () => {
    const plugin = htlPlugin();
    const ctx = makeCtx();
    plugin.load.call(ctx, toVirtualId(cardHtml));
    expect(ctx.watched).toContain(cardHtml);
  });

  describe('configureServer() — HMR for .html source changes', () => {
    // Build a minimal fake Vite dev server.
    function makeServer() {
      const watcherAdds: unknown[] = [];
      const changeHandlers: Array<(file: string) => void> = [];
      const wsMessages: unknown[] = [];
      const invalidated: unknown[] = [];
      const modules = new Map<string, unknown>();
      return {
        watcher: {
          add: (paths: unknown) => watcherAdds.push(paths),
          on: (event: string, cb: (file: string) => void) => {
            if (event === 'change') changeHandlers.push(cb);
          },
        },
        moduleGraph: {
          getModuleById: (id: string) => modules.get(id),
          invalidateModule: (mod: unknown) => invalidated.push(mod),
        },
        ws: { send: (msg: unknown) => wsMessages.push(msg) },
        setModule(id: string, mod: unknown) {
          modules.set(id, mod);
        },
        fireChange(file: string) {
          changeHandlers.forEach((cb) => cb(file));
        },
        get watcherAdds() {
          return watcherAdds;
        },
        get wsMessages() {
          return wsMessages;
        },
        get invalidated() {
          return invalidated;
        },
      };
    }

    it('invalidates the matching virtual module and full-reloads when its .html source changes', () => {
      const plugin = htlPlugin();
      const server = makeServer();
      const virtualId = toVirtualId(cardHtml);
      const fakeMod = { id: virtualId };
      server.setModule(virtualId, fakeMod);

      plugin.configureServer(server);
      server.fireChange(cardHtml);

      expect(server.invalidated).toEqual([fakeMod]);
      expect(server.wsMessages).toEqual([{ type: 'full-reload' }]);
    });

    it('still full-reloads on a matching .html change even if the module was never loaded into the graph', () => {
      const plugin = htlPlugin();
      const server = makeServer();

      plugin.configureServer(server);
      server.fireChange(cardHtml);

      expect(server.invalidated).toEqual([]);
      expect(server.wsMessages).toEqual([{ type: 'full-reload' }]);
    });

    it('reacts to .html changes even when no i18n path is configured (previously configureServer bailed out entirely)', () => {
      const plugin = htlPlugin();
      const server = makeServer();

      plugin.configureServer(server);
      server.fireChange(cardHtml);

      expect(server.wsMessages).toEqual([{ type: 'full-reload' }]);
    });

    it('ignores changes to files excluded from transformation', () => {
      const plugin = htlPlugin({ exclude: /\.stories\.html$/ });
      const storyHtml = path.join(
        tmpDir,
        'apps',
        'mysite',
        'card',
        'card.stories.html'
      );
      fs.writeFileSync(storyHtml, '<div></div>');
      const server = makeServer();

      plugin.configureServer(server);
      server.fireChange(storyHtml);

      expect(server.wsMessages).toEqual([]);
      expect(server.invalidated).toEqual([]);
    });

    it('ignores changes to non-.html files', () => {
      const plugin = htlPlugin();
      const server = makeServer();

      plugin.configureServer(server);
      server.fireChange(
        path.join(tmpDir, 'apps', 'mysite', 'card', 'card.js')
      );

      expect(server.wsMessages).toEqual([]);
    });

    it('full-reloads without touching the module graph when the i18n file changes', () => {
      const i18nPath = path.join(tmpDir, 'i18n.xml');
      fs.writeFileSync(i18nPath, '<xml/>');
      const plugin = htlPlugin({ i18nPath });
      const server = makeServer();

      plugin.configureServer(server);
      server.fireChange(i18nPath);

      expect(server.wsMessages).toEqual([{ type: 'full-reload' }]);
      expect(server.invalidated).toEqual([]);
    });

    it('adds string include directories to the file watcher', () => {
      const includeDir = path.join(tmpDir, 'apps', 'mysite');
      const plugin = htlPlugin({ include: includeDir });
      const server = makeServer();

      plugin.configureServer(server);

      expect(server.watcherAdds).toContainEqual([includeDir]);
    });

    it('does not add non-string include patterns (e.g. RegExp) to the watcher', () => {
      const plugin = htlPlugin({ include: /\.html$/ });
      const server = makeServer();

      plugin.configureServer(server);

      expect(server.watcherAdds).toEqual([]);
    });
  });

  describe('config() — esbuild dependency-optimizer scan stub', () => {
    function setupStub(plugin: ReturnType<typeof htlPlugin>) {
      const config = (plugin as any).config();
      const esbuildPlugin = config.optimizeDeps.esbuildOptions.plugins[0];
      const onLoadHandlers: Array<{
        options: { filter: RegExp; namespace?: string };
        cb: (args?: any) => any;
      }> = [];
      esbuildPlugin.setup({
        onLoad: (options: any, cb: any) => onLoadHandlers.push({ options, cb }),
      });
      return onLoadHandlers;
    }

    it('registers exactly one esbuild plugin under optimizeDeps.esbuildOptions', () => {
      const plugin = htlPlugin();
      const config = (plugin as any).config();
      const plugins = config?.optimizeDeps?.esbuildOptions?.plugins;
      expect(plugins).toHaveLength(1);
      expect(plugins[0].name).toBe('htl-to-js-optimize-deps-stub');
    });

    it("registers onLoad for the same 'html' namespace Vite's own scan plugin uses", () => {
      const plugin = htlPlugin();
      const [{ options }] = setupStub(plugin);
      expect(options.namespace).toBe('html');
      expect(options.filter.test('/Users/x/card.htl-js')).toBe(true);
      expect(options.filter.test('/Users/x/card.html')).toBe(false);
    });

    it('stubs a matching virtual id out as an empty CommonJS module', () => {
      const plugin = htlPlugin();
      const [{ cb }] = setupStub(plugin);
      expect(cb()).toEqual({ contents: 'module.exports = {};', loader: 'js' });
    });
  });

  describe('config() — Vite 8+ Rolldown dependency-optimizer scan stub', () => {
    afterEach(() => {
      jest.dontMock('vite/package.json');
      jest.resetModules();
    });

    function loadPluginWithViteVersion(version: string) {
      jest.doMock('vite/package.json', () => ({ version }), { virtual: true });
      jest.resetModules();
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return require('../src/vite').htlPlugin;
    }

    it('registers under optimizeDeps.rolldownOptions on Vite 8+', () => {
      const htlPluginWithVite8 = loadPluginWithViteVersion('8.1.0');
      const plugin = htlPluginWithVite8();
      const config = (plugin as any).config();
      const plugins = config?.optimizeDeps?.rolldownOptions?.plugins;
      expect(config.optimizeDeps.esbuildOptions).toBeUndefined();
      expect(plugins).toHaveLength(1);
      expect(plugins[0].name).toBe('htl-to-js-optimize-deps-stub');
    });

    it('still registers under optimizeDeps.esbuildOptions on pre-8 Vite', () => {
      const htlPluginWithVite7 = loadPluginWithViteVersion('7.4.0');
      const plugin = htlPluginWithVite7();
      const config = (plugin as any).config();
      expect(config.optimizeDeps.rolldownOptions).toBeUndefined();
      expect(config.optimizeDeps.esbuildOptions.plugins).toHaveLength(1);
    });

    it('stubs a matching virtual id under the html namespace and ignores others', () => {
      const htlPluginWithVite8 = loadPluginWithViteVersion('8.1.0');
      const plugin = htlPluginWithVite8();
      const config = (plugin as any).config();
      const { load } = config.optimizeDeps.rolldownOptions.plugins[0];
      expect(load('html:/Users/x/card.htl-js')).toBe('module.exports = {};');
      expect(load('/Users/x/card.htl-js')).toBeNull();
      expect(load('html:/Users/x/card.html')).toBeNull();
    });
  });
});
