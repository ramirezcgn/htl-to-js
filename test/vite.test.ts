import { htlPlugin } from '../src/vite';

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
  it('has the expected plugin shape', () => {
    const plugin = htlPlugin();
    expect(plugin.name).toBe('htl-to-js');
    expect(plugin.enforce).toBe('pre');
  });

  it('ignores non-.html ids', () => {
    const plugin = htlPlugin();
    const ctx = makeCtx();
    const result = plugin.transform.call(ctx, '<div></div>', '/apps/mysite/card/card.js');
    expect(result).toBeNull();
  });

  it('ignores ids outside of include', () => {
    const plugin = htlPlugin({ include: '/apps/othersite' });
    const ctx = makeCtx();
    const result = plugin.transform.call(ctx, '<div></div>', '/apps/mysite/card/card.html');
    expect(result).toBeNull();
  });

  it('ignores ids matching exclude', () => {
    const plugin = htlPlugin({ exclude: /\.stories\.html$/ });
    const ctx = makeCtx();
    const result = plugin.transform.call(
      ctx,
      '<div></div>',
      '/apps/mysite/card/card.stories.html'
    );
    expect(result).toBeNull();
  });

  it('transpiles to ESM output with no source map', () => {
    const plugin = htlPlugin({ include: '/apps/mysite' });
    const ctx = makeCtx();
    const result = plugin.transform.call(
      ctx,
      '<div>${model.title}</div>',
      '/apps/mysite/card/card.html'
    );
    expect(result?.code).toContain('export { createCard }');
    expect(result?.map).toBeNull();
  });

  it('watches the i18n file and reports parse failures as warnings', () => {
    const plugin = htlPlugin({ i18nPath: '/does/not/exist.xml' });
    const ctx = makeCtx();
    plugin.transform.call(ctx, '<div>${model.title}</div>', '/apps/mysite/card/card.html');
    expect(ctx.watched).toContain('/does/not/exist.xml');
    expect(ctx.warnings[0]).toContain('Could not load i18n file');
  });

  it('on transpile error: reports via this.error() with the file path', () => {
    const plugin = htlPlugin();
    const ctx = makeCtx();
    expect(() =>
      plugin.transform.call(ctx, null as any, '/apps/mysite/broken/broken.html')
    ).toThrow(/broken\.html/);
    expect(ctx.errors).toHaveLength(1);
  });
});
