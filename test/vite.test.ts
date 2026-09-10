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
    // Empty file — nothing forces a transpile failure via content alone, the
    // error-path test below drives it a different way (invalid resolved id).
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
    // Vite's own `vite:build-html` plugin reprocesses any id passing a raw
    // `id.endsWith('.html')` check — the virtual id must fail that check,
    // not just carry a `\0` prefix in front of the same trailing text.
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
    // `fileOverrides` entries are processed unconditionally at the top of
    // `transpile()`, so an invalid one reliably throws regardless of the
    // main source content — a simpler, deterministic failure than trying
    // to craft HTL the parser itself rejects.
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
});
