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
