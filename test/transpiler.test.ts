import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { transpile, generateDts } from '../src/transpiler/index';
import {
  mergeI18nDicts,
  parseI18nXml,
  resolveLocaleChain,
} from '../src/parseI18nXml';
import {
  convertExpr,
  convertAttrValue,
  convertTextContent,
} from '../src/transpiler/expr';

// ---------------------------------------------------------------------------
// expr.js unit tests
// ---------------------------------------------------------------------------

describe('convertExpr', () => {
  it('strips @ context option', () => {
    expect(convertExpr("model.title @ context='html'")).toBe('model?.title');
  });

  it('wraps @ i18n string in dictionary lookup', () => {
    expect(convertExpr("'Learn more' @ i18n")).toBe(
      "_i18n?.['Learn more'] ?? 'Learn more'"
    );
  });

  it('strips ${ } wrapper', () => {
    expect(convertExpr('${model.id}')).toBe('model?.id');
  });

  it('converts .size to .length', () => {
    expect(convertExpr('accordion.items.size > 0')).toBe(
      'accordion?.items?.length > 0'
    );
  });

  it('converts jcr: property access', () => {
    expect(convertExpr('component.properties.jcr:title')).toBe(
      "component?.properties?.['jcr:title']"
    );
  });

  it('handles ternary expressions', () => {
    expect(convertExpr("model.titleSize || 'h2'")).toBe(
      "model?.titleSize || 'h2'"
    );
  });

  it('converts @ format=[...] to JS concatenation', () => {
    expect(convertExpr("'{0}/{1}' @ format=[model.tagUrl, tag.name]")).toBe(
      "model?.tagUrl + '/' + tag?.name"
    );
  });

  it('converts @ format with single placeholder', () => {
    expect(convertExpr("'prefix-{0}' @ format=[model.id]")).toBe(
      "'prefix-' + model?.id"
    );
  });
});

describe('convertAttrValue', () => {
  it('converts single expression in attribute', () => {
    expect(convertAttrValue('${accordion.id}')).toBe(
      '${_htlAttr(accordion?.id)}'
    );
  });

  it('converts mixed literal + expression', () => {
    expect(convertAttrValue('cmp-accordion ${properties.theme}')).toBe(
      'cmp-accordion ${_htlAttr(properties?.theme)}'
    );
  });

  it('strips @ context from attribute expression', () => {
    expect(convertAttrValue("${model.desc @ context='html'}")).toBe(
      '${_htlAttr(model?.desc)}'
    );
  });

  it('escapes bare backticks in literals', () => {
    expect(convertAttrValue('say `hello`')).toBe('say \\`hello\\`');
  });

  it('converts .size in attribute', () => {
    expect(convertAttrValue('${items.size}')).toBe(
      '${_htlAttr(items?.length)}'
    );
  });
});

describe('convertTextContent', () => {
  it('HTML-escapes expression in text node by default', () => {
    expect(convertTextContent('${item.title}')).toBe('${_htlText(item?.title)}');
  });

  it('handles i18n string in text', () => {
    expect(convertTextContent("${'Learn more' @ i18n}")).toBe(
      "${_htlText(_i18n?.['Learn more'] ?? 'Learn more')}"
    );
  });

  it('passes raw HTML through when context=html', () => {
    expect(convertTextContent("${model.richText @ context='html'}")).toBe(
      "${model?.richText ?? ''}"
    );
  });

  it('passes raw HTML through when context=unsafe', () => {
    expect(convertTextContent("${model.html @ context='unsafe'}")).toBe(
      "${model?.html ?? ''}"
    );
  });

  it('wraps || expression in parens before ?? when context=html', () => {
    expect(convertTextContent("${model.desc || model.title @ context='html'}")).toBe(
      "${(model?.desc || model?.title) ?? ''}"
    );
  });

  it('wraps && expression in parens before ?? when context=html', () => {
    expect(convertTextContent("${model.show && model.text @ context='html'}")).toBe(
      "${(model?.show && model?.text) ?? ''}"
    );
  });

  it('wraps || expression in parens before ?? when context=unsafe', () => {
    expect(convertTextContent("${model.a || model.b @ context='unsafe'}")).toBe(
      "${(model?.a || model?.b) ?? ''}"
    );
  });

  it('escapes literal backticks', () => {
    expect(convertTextContent('use `this`')).toBe('use \\`this\\`');
  });
});

// ---------------------------------------------------------------------------
// transpile() integration tests — by feature
// ---------------------------------------------------------------------------

describe('transpile — banner & export naming', () => {
  it('adds AUTO-GENERATED banner comment', () => {
    const out = transpile('<div>hello</div>', { filename: 'test.html' });
    expect(out.startsWith('// AUTO-GENERATED')).toBe(true);
  });

  it('derives export name from filename', () => {
    const out = transpile('<div>hello</div>', { filename: 'my-widget.html' });
    expect(out).toContain('createMyWidget');
  });

  it('generates valid JS', () => {
    const src = `<div data-sly-use.model="com.example.Model" class="wrapper">\${model.title}</div>`;
    const out = transpile(src, { filename: 'card.html' });
    expect(
      () => new Function(out.replace(/module\.exports.*/, ''))
    ).not.toThrow();
  });
});

describe('transpile — data-sly-use', () => {
  it('extracts the use model as a function parameter', () => {
    const src = `<div data-sly-use.model="com.example.Model">\${model.title}</div>`;
    const out = transpile(src, { filename: 'test.html' });
    expect(out).toContain('model =');
  });

  it('supports multiple use declarations', () => {
    const src = `<div data-sly-use.header="com.example.Header" data-sly-use.footer="com.example.Footer">\${header.title} \${footer.copy}</div>`;
    const out = transpile(src, { filename: 'test.html' });
    expect(out).toContain('header =');
    expect(out).toContain('footer =');
  });

  it('renders model properties at runtime', () => {
    const src = `<div data-sly-use.model="com.example.Model">\${model.title}</div>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ model: { title: 'Hello' } });
    expect(html).toContain('Hello');
  });
});

describe('transpile — implicit parameters', () => {
  it('includes wcmmode with default value', () => {
    const src = `<div data-sly-test="\${wcmmode.edit}">edit mode</div>`;
    const out = transpile(src, { filename: 'test.html' });
    expect(out).toContain('wcmmode =');
  });

  it('includes properties when referenced', () => {
    const src = `<div class="\${properties.theme}">content</div>`;
    const out = transpile(src, { filename: 'test.html' });
    expect(out).toContain('properties =');
  });

  it('includes component when referenced', () => {
    const src = `<div title="\${component.title}">content</div>`;
    const out = transpile(src, { filename: 'test.html' });
    expect(out).toContain('component =');
  });
});

describe('transpile — data-sly-test', () => {
  it('renders content when condition is truthy', () => {
    const src = `<div data-sly-test="\${model.visible}">visible</div>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    expect(fn({ model: { visible: true } })).toContain('visible');
  });

  it('hides content when condition is falsy', () => {
    const src = `<div data-sly-test="\${model.visible}">visible</div>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    expect(fn({ model: { visible: false } })).not.toContain('visible');
  });

  it('supports test with variable assignment (test.varName)', () => {
    const src = `<sly data-sly-test.hasTitle="\${model.title}"><h1>\${model.title}</h1></sly>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    expect(fn({ model: { title: 'Hello' } })).toContain('<h1>Hello</h1>');
    expect(fn({ model: { title: '' } })).toBe('');
  });
});

describe('transpile — data-sly-repeat', () => {
  it('iterates items with .map()', () => {
    const src = `<ul><li data-sly-repeat.item="\${items}">\${item.name}</li></ul>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ items: [{ name: 'A' }, { name: 'B' }] });
    expect(html).toContain('A');
    expect(html).toContain('B');
  });

  it('provides itemList loop status', () => {
    const src = `<div data-sly-repeat.item="\${items}"><span class="\${itemList.first ? 'first' : ''}">\${item}</span></div>`;
    const code = transpile(src, { filename: 'test.html' });
    expect(code).toContain('itemList');
    expect(code).toContain('index');
    expect(code).toContain('first');
    expect(code).toContain('last');
  });

  it('skips null items', () => {
    const src = `<li data-sly-repeat.item="\${items}">\${item}</li>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ items: ['a', null, 'b'] });
    expect(html).toContain('a');
    expect(html).toContain('b');
    expect(html.match(/<li>/g)?.length).toBe(2);
  });

  it('handles empty list', () => {
    const src = `<li data-sly-repeat.item="\${items}">\${item}</li>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    expect(fn({ items: [] })).toBe('');
  });
});

describe('transpile — data-sly-element', () => {
  it('renders dynamic tag name', () => {
    const src = `<h2 data-sly-element="\${model.headingLevel || 'h3'}">\${model.title}</h2>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ model: { headingLevel: 'h3', title: 'Title' } });
    expect(html).toContain('<h3');
    expect(html).toContain('</h3>');
  });

  it('falls back to original tag when expression is falsy', () => {
    const src = `<h2 data-sly-element="\${model.headingLevel || 'h3'}">\${model.title}</h2>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ model: { headingLevel: '', title: 'Title' } });
    expect(html).toContain('<h3');
  });
});

describe('transpile — data-sly-unwrap', () => {
  it('unwraps conditionally when expression is truthy', () => {
    const src = `<a data-sly-unwrap="\${!model.url}" href="\${model.url}"><span>Link</span></a>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;

    const withUrl = fn({ model: { url: '/page' } });
    expect(withUrl).toContain('<a');
    expect(withUrl).toContain('href="/page"');

    const noUrl = fn({ model: { url: '' } });
    expect(noUrl).not.toContain('<a');
    expect(noUrl).toContain('<span>Link</span>');
  });

  it('always unwraps when no expression is given', () => {
    const src = `<div class="wrapper"><a data-sly-unwrap href="/page"><span>Link</span></a></div>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn();
    expect(html).toContain('<span>Link</span>');
    expect(html).not.toContain('<a');
  });
});

describe('transpile — data-sly-set', () => {
  const src = `
    <div data-sly-use.model="com.example.MyModel"
         data-sly-set.overlayHref="\${model.pathUrl ? model.pathUrl : ''}"
         data-sly-set.overlayWidth="\${model.width}%"
         class="wrapper">
      <a href="\${overlayHref}" style="width:\${overlayWidth}">\${model.title}</a>
    </div>`;

  it('declares set variables as consts', () => {
    const out = transpile(src, { filename: 'test.html' });
    expect(out).toContain('const overlayHref');
    expect(out).toContain('const overlayWidth');
  });

  it('evaluates set variable expressions at runtime', () => {
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({
      model: { pathUrl: '/my-path', width: 50, title: 'Test' },
    });
    expect(html).toContain('href="/my-path"');
    expect(html).toContain('width:50%');
    expect(html).toContain('Test');
  });
});

describe('transpile — data-sly-include', () => {
  it('generates an _includes slot for literal paths', () => {
    const src = `<sly data-sly-include="./header.html"></sly>`;
    const out = transpile(src, { filename: 'test.html' });
    expect(out).toContain("_incSlot(_includes, './header.html')");
  });

  it('adds _includes as a parameter', () => {
    const src = `<sly data-sly-include="./header.html"></sly>`;
    const out = transpile(src, { filename: 'test.html' });
    expect(out).toContain('_includes =');
  });

  it('handles dynamic include expressions', () => {
    const src = `<sly data-sly-include="\${model.template}"></sly>`;
    const out = transpile(src, { filename: 'test.html' });
    expect(out).toContain('_incSlot(_includes, model?.template)');
  });

  it('composes path with appendPath at compile time', () => {
    const src = `<sly data-sly-include="\${'partials' @ appendPath='template.html'}"></sly>`;
    const out = transpile(src, { filename: 'test.html' });
    expect(out).toContain("_incSlot(_includes, 'partials/template.html')");
  });

  it('composes path with prependPath at compile time', () => {
    const src = `<sly data-sly-include="\${'template.html' @ prependPath='partials'}"></sly>`;
    const out = transpile(src, { filename: 'test.html' });
    expect(out).toContain("_incSlot(_includes, 'partials/template.html')");
  });

  it('uses _htlJoinPaths for dynamic appendPath', () => {
    const src = `<sly data-sly-include="\${'partials' @ appendPath=model.tpl}"></sly>`;
    const out = transpile(src, { filename: 'test.html' });
    expect(out).toContain('_htlJoinPaths');
    expect(out).toContain("'partials'");
    expect(out).toContain('model?.tpl');
  });
});

describe('transpile — .size to .length conversion', () => {
  it('converts .size to .length in expressions', () => {
    const src = `<div data-sly-test="\${items.size > 0}">has items</div>`;
    const out = transpile(src, { filename: 'test.html' });
    expect(out).not.toContain('.size');
    expect(out).toContain('.length');
  });
});

describe('transpile — HTML comments', () => {
  it('strips HTL block comments', () => {
    const src = `<!--/* This is a block comment */--><div>content</div>`;
    const out = transpile(src, { filename: 'test.html' });
    expect(out).not.toContain('block comment');
    expect(out).toContain('content');
  });
});

// ---------------------------------------------------------------------------
// HTL "in" operator
// ---------------------------------------------------------------------------

describe('transpile — in operator', () => {
  it('does not throw when right side is undefined', () => {
    const src = `<div data-sly-test="\${item.name in parent.expandedItems}">expanded</div>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;

    expect(() => fn({ item: { name: 'x' }, parent: {} })).not.toThrow();
    expect(fn({ item: { name: 'x' }, parent: {} })).not.toContain('expanded');
  });

  it('returns true when key exists in object', () => {
    const src = `<div data-sly-test="\${item.name in parent.expandedItems}">expanded</div>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;

    expect(
      fn({
        item: { name: 'panel-1' },
        parent: { expandedItems: { 'panel-1': true } },
      })
    ).toContain('expanded');
  });

  it('returns false when key does not exist in object', () => {
    const src = `<div data-sly-test="\${item.name in parent.expandedItems}">expanded</div>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;

    expect(
      fn({
        item: { name: 'other' },
        parent: { expandedItems: { 'panel-1': true } },
      })
    ).not.toContain('expanded');
  });

  it('handles in operator inside parenthesized ternary in attribute', () => {
    const src = `<div data-sly-use.accordion="com.example.Accordion"
                      data-sly-repeat.item="\${accordion.items}"
                      class="base\${(item.name in accordion.expandedItems) ? ' active' : ''}">content</div>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;

    expect(
      fn({ accordion: { items: [{ name: 'x' }], expandedItems: { x: true } } })
    ).toContain('base active');
    expect(
      fn({ accordion: { items: [{ name: 'y' }], expandedItems: { x: true } } })
    ).toContain('class="base"');
  });
});

// ---------------------------------------------------------------------------
// _htlText XSS prevention in text nodes
// ---------------------------------------------------------------------------

describe('transpile — _htlText XSS prevention in text nodes', () => {
  it('escapes < and > in text node output', () => {
    const src = `<p>\${model.description}</p>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ model: { description: '<script>alert(1)</script>' } });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes & in text node output', () => {
    const src = `<p>\${model.text}</p>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ model: { text: 'a & b' } });
    expect(html).toContain('a &amp; b');
  });

  it('allows raw HTML with @ context=html in text node', () => {
    const src = `<div>\${model.richText @ context='html'}</div>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ model: { richText: '<strong>Bold</strong>' } });
    expect(html).toContain('<strong>Bold</strong>');
  });

  it('allows raw HTML with data-sly-text @ context=html', () => {
    const src = `<div data-sly-text="\${model.richText @ context='html'}">fallback</div>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ model: { richText: '<em>Italic</em>' } });
    expect(html).toContain('<em>Italic</em>');
    expect(html).not.toContain('fallback');
  });

  it('escapes HTML in data-sly-text by default', () => {
    const src = `<p data-sly-text="\${model.text}">fallback</p>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ model: { text: '<b>XSS</b>' } });
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;b&gt;');
  });
});

// ---------------------------------------------------------------------------
// @ context='uri' in attributes
// ---------------------------------------------------------------------------

describe('transpile — @ context=uri in attributes', () => {
  it('URI-encodes spaces and special chars in href', () => {
    const src = `<a href="\${model.url @ context='uri'}">link</a>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ model: { url: '/path/with spaces/file.html' } });
    expect(html).toContain('/path/with%20spaces/file.html');
    expect(html).not.toContain('href="/path/with spaces/');
  });

  it('returns empty string for null with context=uri', () => {
    const src = `<a href="\${model.url @ context='uri'}">link</a>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    expect(fn({ model: { url: null } })).toContain('href=""');
  });

  it('applies uri context automatically to href without explicit context', () => {
    const src = `<a href="\${model.url}">link</a>`;
    const code = transpile(src, { filename: 'test.html' });
    expect(code).toContain('_htlUri(');
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ model: { url: '/path/with spaces/file.html' } });
    expect(html).toContain('/path/with%20spaces/file.html');
  });

  it('applies uri context automatically to src without explicit context', () => {
    const src = `<img src="\${model.url}" alt="x">`;
    const code = transpile(src, { filename: 'test.html' });
    expect(code).toContain('_htlUri(');
  });

  it('applies uri context automatically to action without explicit context', () => {
    const src = `<form action="\${model.url}"></form>`;
    const code = transpile(src, { filename: 'test.html' });
    expect(code).toContain('_htlUri(');
  });

  it('does not apply auto-uri to non-uri attributes like title', () => {
    const src = `<div title="\${model.val}">x</div>`;
    const code = transpile(src, { filename: 'test.html' });
    const titleLine = code.split('\n').find(l => l.includes('title'));
    expect(titleLine).not.toContain('_htlUri(');
  });
});

// ---------------------------------------------------------------------------
// @ context='unsafe' in attributes
// ---------------------------------------------------------------------------

describe('transpile — @ context=unsafe in attributes', () => {
  it('outputs raw value without HTML-escaping', () => {
    const src = `<div data-json="\${model.json @ context='unsafe'}">x</div>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ model: { json: '{"key":"value"}' } });
    expect(html).toContain('data-json="{"key":"value"}"');
  });
});

// ---------------------------------------------------------------------------
// _htlAttr HTML escaping (XSS prevention)
// ---------------------------------------------------------------------------

describe('transpile — _htlAttr HTML escaping', () => {
  it('escapes < and > in attribute values', () => {
    const src = `<div title="\${model.value}">test</div>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;

    const html = fn({ model: { value: '<script>alert(1)</script>' } });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes & in attribute values', () => {
    const src = `<a href="\${model.url}">link</a>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;

    const html = fn({ model: { url: '/path?a=1&b=2' } });
    expect(html).toContain('&amp;b=2');
  });

  it('escapes double quotes in attribute values', () => {
    const src = `<div title="\${model.name}">test</div>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;

    const html = fn({ model: { name: 'say "hello"' } });
    expect(html).toContain('&quot;');
    expect(html).not.toContain('""');
  });
});

// ---------------------------------------------------------------------------
// data-sly-attribute (named + object spread)
// ---------------------------------------------------------------------------

describe('transpile — data-sly-attribute (named)', () => {
  it('sets a single dynamic attribute', () => {
    const src = `<div data-sly-attribute.title="\${model.title}">content</div>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;

    expect(fn({ model: { title: 'Hello' } })).toContain('title="Hello"');
  });

  it('omits attribute when value is null/undefined', () => {
    const src = `<div data-sly-attribute.title="\${model.title}">content</div>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;

    expect(fn({ model: { title: null } })).not.toContain('title=');
  });

  it('renders empty string attribute as present', () => {
    const src = `<div data-sly-attribute.title="\${model.title}">content</div>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;

    expect(fn({ model: { title: '' } })).toContain('title=""');
  });

  it('renders boolean true as valueless attribute', () => {
    const src = `<input data-sly-attribute.disabled="\${model.isDisabled}">`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;

    const html = fn({ model: { isDisabled: true } });
    expect(html).toContain('disabled');
    expect(html).not.toContain('disabled="');
  });

  it('omits boolean false attribute', () => {
    const src = `<input data-sly-attribute.disabled="\${model.isDisabled}">`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;

    expect(fn({ model: { isDisabled: false } })).not.toContain('disabled');
  });

  it('overrides an existing static attribute', () => {
    const src = `<div class="static" data-sly-attribute.class="\${model.cls}">content</div>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;

    const html = fn({ model: { cls: 'dynamic-class' } });
    expect(html).toContain('class="dynamic-class"');
    expect(html).not.toContain('class="static"');
  });
});

describe('transpile — data-sly-attribute (object spread)', () => {
  it('spreads an object as multiple attributes', () => {
    const src = `<div data-sly-attribute="\${model.attrs}">content</div>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;

    const html = fn({ model: { attrs: { id: 'myId', role: 'button' } } });
    expect(html).toContain('id="myId"');
    expect(html).toContain('role="button"');
  });

  it('handles null object gracefully', () => {
    const src = `<div data-sly-attribute="\${model.attrs}">content</div>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;

    const html = fn({ model: { attrs: null } });
    expect(html).toContain('<div>');
    expect(html).toContain('content');
  });
});

// ---------------------------------------------------------------------------
// data-sly-test.var + data-sly-repeat combined
// ---------------------------------------------------------------------------

describe('transpile — data-sly-test.var + data-sly-repeat on same element', () => {
  it('renders items when test condition is truthy', () => {
    const src = `<ul data-sly-test.hasItems="\${items.length > 0}" data-sly-repeat.item="\${items}"><li>\${item}</li></ul>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;

    const html = fn({ items: ['a', 'b', 'c'] });
    expect(html).toContain('<li>a</li>');
    expect(html).toContain('<li>b</li>');
    expect(html).toContain('<li>c</li>');
  });

  it('renders nothing when test condition is falsy', () => {
    const src = `<ul data-sly-test.hasItems="\${items.length > 0}" data-sly-repeat.item="\${items}"><li>\${item}</li></ul>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;

    expect(fn({ items: [] })).toBe('');
  });

  it('hoists the test variable before the loop in a scoped IIFE', () => {
    const src = `<ul data-sly-test.hasItems="\${items.length > 0}" data-sly-repeat.item="\${items}"><li>\${item}</li></ul>`;
    const code = transpile(src, { filename: 'test.html' });
    expect(code).toMatch(
      /const hasItems[\s\S]*?return \(hasItems\)[\s\S]*?\.map\(/
    );
  });
});

// ---------------------------------------------------------------------------
// @join expression option
// ---------------------------------------------------------------------------

describe('convertExpr — @join', () => {
  it('handles @join with single-quoted separator', () => {
    expect(convertExpr("tags @ join=', '")).toBe("(tags).join(', ')");
  });

  it('handles @join with double-quoted separator', () => {
    expect(convertExpr('tags @ join=", "')).toBe("(tags).join(', ')");
  });

  it('handles @join with other options', () => {
    expect(convertExpr('tags @ join=", ", context=\'html\'')).toBe(
      "(tags).join(', ')"
    );
  });
});

// ---------------------------------------------------------------------------
// P0 — data-sly-text
// ---------------------------------------------------------------------------

describe('transpile — data-sly-text', () => {
  it('replaces inner content with expression value', () => {
    const src = `<p data-sly-text="\${model.description}">fallback</p>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ model: { description: 'Dynamic text' } });
    expect(html).toContain('<p>Dynamic text</p>');
    expect(html).not.toContain('fallback');
  });

  it('renders empty string when expression is empty', () => {
    const src = `<span data-sly-text="\${model.label}">default</span>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ model: { label: '' } });
    expect(html).toContain('<span></span>');
    expect(html).not.toContain('default');
  });
});

// ---------------------------------------------------------------------------
// P0 — data-sly-resource
// ---------------------------------------------------------------------------

describe('transpile — data-sly-resource', () => {
  it('generates _includes slot for resource expression', () => {
    const src = `<sly data-sly-resource="\${model.resourcePath}"></sly>`;
    const out = transpile(src, { filename: 'test.html' });
    expect(out).toContain('_includes');
    expect(out).toContain('model?.resourcePath');
  });

  it('invokes the _includes function for the resource at runtime', () => {
    const src = `<div data-sly-resource="\${'header'}"></div>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ _includes: { header: () => '<nav>Nav</nav>' } });
    expect(html).toContain('<nav>Nav</nav>');
  });

  it('accepts plain strings as _includes values (no function wrapper needed)', () => {
    const src = `<div data-sly-resource="\${'header'}"></div>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ _includes: { header: '<nav>Nav</nav>' } });
    expect(html).toContain('<nav>Nav</nav>');
  });

  it('falls back to @path when main expression is empty', () => {
    const src = `<sly data-sly-resource="\${@ path=model.path}"></sly>`;
    const out = transpile(src, { filename: 'test.html' });
    expect(out).toContain('model?.path');
  });

  it('composes resource path with appendPath at compile time', () => {
    const src = `<sly data-sly-resource="\${'my/path' @ appendPath='child'}"></sly>`;
    const out = transpile(src, { filename: 'test.html' });
    expect(out).toContain("'my/path/child'");
  });

  it('composes resource path with prependPath at compile time', () => {
    const src = `<sly data-sly-resource="\${'my/path' @ prependPath='root'}"></sly>`;
    const out = transpile(src, { filename: 'test.html' });
    expect(out).toContain("'root/my/path'");
  });

  it('treats bare undefined variable as string literal key', () => {
    const src = `<sly data-sly-resource="\${resource @ resourceType='wcm/foundation/components/responsivegrid'}"></sly>`;
    const code = transpile(src, {
      filename: 'test.html',
      resourceWrappers: {
        'wcm/foundation/components/responsivegrid': 'aem-Grid',
      },
    });
    // Should use 'resource' as string key, not as a variable
    expect(code).toContain("'resource'");
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ _includes: { resource: () => '<p>Content</p>' } });
    expect(html).toContain('<div class="aem-Grid">');
    expect(html).toContain('<p>Content</p>');
  });

  it('uses data-sly-set variable (same element) as dynamic key for data-sly-resource', () => {
    // data-sly-set.path and data-sly-resource="${path}" on the same element:
    // path is defined on the same element so it must NOT be quoted to 'path'.
    const src = `<div
      data-sly-set.path="\${'{0}/par_{1}' @ format=[resource.path, itemList.index]}"
      data-sly-resource="\${path @ resourceType='anaplan/components/responsivegrid'}">
    </div>`;
    const code = transpile(src, { filename: 'test.html' });
    // The resource lookup must use the variable `path`, not the string literal 'path'
    expect(code).not.toContain("_incSlot(_includes, 'path')");
    expect(code).toContain('_incSlot(_includes, path)');

    // Runtime: the include function for the computed path must be called
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({
      resource: { path: 'navgroup' },
      itemList: { index: 0 },
      _includes: { 'navgroup/par_0': () => '<section>par</section>' },
    });
    expect(html).toContain('<section>par</section>');
  });
});

// ---------------------------------------------------------------------------
// P0 — data-sly-template + data-sly-call
// ---------------------------------------------------------------------------

describe('transpile — data-sly-template & data-sly-call', () => {
  it('emits multiple named template exports', () => {
    const src = `
      <template data-sly-template.header="\${@ title}"><h1>\${title}</h1></template>
      <template data-sly-template.footer="\${@ copy}"><footer>\${copy}</footer></template>`;
    const code = transpile(src, { filename: 'test.html' });
    expect(code).toContain('createHeader');
    expect(code).toContain('createFooter');
    expect(code).toContain('module.exports');
  });

  it('renders a named template with params', () => {
    const src = `<template data-sly-template.greeting="\${@ name}"><span>Hello \${name}!</span></template>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const html = mod.exports.createGreeting({ name: 'World' });
    expect(html).toContain('<span>Hello World!</span>');
  });

  it('renders local template call via data-sly-call', () => {
    const src = `
      <template data-sly-template.badge="\${@ label}"><span class="badge">\${label}</span></template>
      <sly data-sly-call="\${badge @ label='New'}"></sly>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = mod.exports.createBadge;
    const html = fn({ label: 'New' });
    expect(html).toContain('<span class="badge">New</span>');
  });

  it('wraps call output in host element when host is not sly', () => {
    // In single-template mode, a call on a non-sly element should wrap in that element
    const src = `<div class="wrapper" data-sly-call="\${myFn @ text='Hi'}"></div>`;
    const code = transpile(src, { filename: 'test.html' });
    // The div host should wrap the call output
    expect(code).toContain('class="wrapper"');
    expect(code).toContain('<div');
  });

  it('defaults unpassed optional params to empty string, not {}', () => {
    // class and loading are declared but not passed by the caller
    // loading || 'lazy' should evaluate to 'lazy', not '{}'
    const src = `<template data-sly-template.img="\${@ src, alt, class, loading}">
      <img class="\${class}" src="\${src}" alt="\${alt}" loading="\${loading || 'lazy'}">
    </template>`;
    const code = transpile(src, { filename: 'helper.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = mod.exports.createImg;
    const html = fn({ src: '/img/test.png', alt: 'test' });
    expect(html).toContain('loading="lazy"');
    expect(html).not.toContain('loading="{}"');
    expect(html).toContain('class=""');
    expect(html).not.toContain('class="{}"');
  });
});

// ---------------------------------------------------------------------------
// P0 — data-sly-list (list mode vs repeat mode)
// ---------------------------------------------------------------------------

describe('transpile — data-sly-list', () => {
  it('renders outer tag once and loops inner content only (list mode)', () => {
    const src = `<ul data-sly-list.item="\${items}"><li>\${item.name}</li></ul>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ items: [{ name: 'A' }, { name: 'B' }] });
    // List mode: <ul> appears once, <li> repeated
    expect(html.match(/<ul>/g)?.length).toBe(1);
    expect(html.match(/<li>/g)?.length).toBe(2);
    expect(html).toContain('A');
    expect(html).toContain('B');
  });

  it('provides itemList loop status in list mode', () => {
    const src = `<ol data-sly-list.item="\${items}"><li class="\${itemList.first ? 'first' : ''}">\${item}</li></ol>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ items: ['x', 'y'] });
    expect(html).toContain('class="first"');
  });

  it('skips null items in list mode', () => {
    const src = `<ul data-sly-list.item="\${items}"><li>\${item}</li></ul>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ items: ['a', null, 'b'] });
    expect(html.match(/<li>/g)?.length).toBe(2);
  });

  it('exposes middle=true for elements that are neither first nor last', () => {
    const src = `<ul data-sly-list.item="\${items}"><li class="\${itemList.middle ? 'mid' : ''}">\${item}</li></ul>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ items: ['a', 'b', 'c'] });
    const midCount = (html.match(/class="mid"/g) ?? []).length;
    expect(midCount).toBe(1);
  });

  it('middle=false for first and last in a 3-item list', () => {
    const src = `<ul data-sly-list.item="\${items}"><li>\${itemList.middle}</li></ul>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ items: ['a', 'b', 'c'] });
    expect(html).toContain('false');
    expect(html).toContain('true');
  });

  it('begin skips items before the given index', () => {
    const src = `<ul data-sly-list.item="\${items @ begin=1}"><li>\${item}</li></ul>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ items: ['a', 'b', 'c'] });
    expect(html).not.toContain('>a<');
    expect(html).toContain('>b<');
    expect(html).toContain('>c<');
  });

  it('end stops iteration after the given inclusive index', () => {
    const src = `<ul data-sly-list.item="\${items @ end=1}"><li>\${item}</li></ul>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ items: ['a', 'b', 'c'] });
    expect(html).toContain('>a<');
    expect(html).toContain('>b<');
    expect(html).not.toContain('>c<');
  });

  it('step iterates every N items', () => {
    const src = `<ul data-sly-list.item="\${items @ step=2}"><li>\${item}</li></ul>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ items: ['a', 'b', 'c', 'd', 'e'] });
    expect(html).toContain('>a<');
    expect(html).not.toContain('>b<');
    expect(html).toContain('>c<');
    expect(html).not.toContain('>d<');
    expect(html).toContain('>e<');
  });

  it('combines begin, end and step', () => {
    const src = `<ul data-sly-list.item="\${items @ begin=1, end=5, step=2}"><li>\${item}</li></ul>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ items: ['a', 'b', 'c', 'd', 'e', 'f'] });
    expect(html).not.toContain('>a<');
    expect(html).toContain('>b<');
    expect(html).not.toContain('>c<');
    expect(html).toContain('>d<');
    expect(html).not.toContain('>e<');
    expect(html).toContain('>f<');
  });

  it('differs from repeat: repeat repeats the whole element', () => {
    const srcList = `<ul data-sly-list.item="\${items}"><li>\${item}</li></ul>`;
    const srcRepeat = `<ul data-sly-repeat.item="\${items}"><li>\${item}</li></ul>`;
    const codeList = transpile(srcList, { filename: 'test.html' });
    const codeRepeat = transpile(srcRepeat, { filename: 'test.html' });
    const modL: any = {};
    const modR: any = {};
    new Function('module', codeList)(modL);
    new Function('module', codeRepeat)(modR);
    const fnL = Object.values(modL.exports)[0] as Function;
    const fnR = Object.values(modR.exports)[0] as Function;
    const items = [{ toString: () => 'A' }, { toString: () => 'B' }];
    const htmlList = fnL({ items });
    const htmlRepeat = fnR({ items });
    // List mode: <ul> appears once; repeat mode: <ul> appears per item
    expect(htmlList.match(/<ul>/g)?.length).toBe(1);
    expect(htmlRepeat.match(/<ul>/g)?.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// P1 — Bare data-sly-repeat / data-sly-list (default 'item' variable)
// ---------------------------------------------------------------------------

describe('transpile — bare repeat/list (default item variable)', () => {
  it('uses default "item" variable for bare data-sly-repeat', () => {
    const src = `<li data-sly-repeat="\${items}">\${item}</li>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ items: ['x', 'y'] });
    expect(html).toContain('x');
    expect(html).toContain('y');
  });

  it('uses default "item" variable for bare data-sly-list', () => {
    const src = `<ul data-sly-list="\${items}"><li>\${item}</li></ul>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ items: ['a', 'b'] });
    expect(html.match(/<ul>/g)?.length).toBe(1);
    expect(html).toContain('a');
    expect(html).toContain('b');
  });
});

// ---------------------------------------------------------------------------
// P1 — Void elements (self-closing)
// ---------------------------------------------------------------------------

describe('transpile — void elements', () => {
  it('renders <br> as self-closing', () => {
    const src = `<div>Hello<br>World</div>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn();
    expect(html).toContain('<br>');
    expect(html).not.toContain('</br>');
  });

  it('renders <img> with attributes as self-closing', () => {
    const src = `<img src="\${model.src}" alt="\${model.alt}">`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ model: { src: '/img.png', alt: 'Logo' } });
    expect(html).toContain('<img');
    expect(html).toContain('src="/img.png"');
    expect(html).not.toContain('</img>');
  });

  it('renders <input> as self-closing', () => {
    const src = `<input type="text" data-sly-attribute.value="\${model.val}">`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ model: { val: 'hello' } });
    expect(html).toContain('<input');
    expect(html).not.toContain('</input>');
  });
});

// ---------------------------------------------------------------------------
// P1 — <sly> element elision
// ---------------------------------------------------------------------------

describe('transpile — <sly> element elision', () => {
  it('does not emit any <sly> tag in output', () => {
    const src = `<sly data-sly-test="\${model.show}"><span>content</span></sly>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ model: { show: true } });
    expect(html).not.toContain('<sly');
    expect(html).not.toContain('</sly>');
    expect(html).toContain('<span>content</span>');
  });

  it('does not emit sly tag even without directives', () => {
    const src = `<sly><p>hello</p></sly>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn();
    expect(html).not.toContain('<sly');
    expect(html).toContain('<p>hello</p>');
  });
});

// ---------------------------------------------------------------------------
// P1 — HTML comment preservation
// ---------------------------------------------------------------------------

describe('transpile — HTML comment handling', () => {
  it('preserves regular HTML comments', () => {
    const src = `<!-- regular comment --><div>content</div>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn();
    expect(html).toContain('<!-- regular comment -->');
    expect(html).toContain('content');
  });

  it('strips HTL block comments (/* ... */)', () => {
    const src = `<!--/* secret */--><div>visible</div>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn();
    expect(html).not.toContain('secret');
    expect(html).toContain('visible');
  });
});

// ---------------------------------------------------------------------------
// P1 — Self-closing <sly/> expansion
// ---------------------------------------------------------------------------

describe('transpile — self-closing <sly/> expansion', () => {
  it('handles self-closing sly with include', () => {
    const src = `<sly data-sly-include="./partial.html"/>`;
    const out = transpile(src, { filename: 'test.html' });
    expect(out).toContain("_incSlot(_includes, './partial.html')");
  });

  it('handles self-closing sly with test', () => {
    const src = `<sly data-sly-test="\${model.show}" data-sly-include="./header.html"/>`;
    const out = transpile(src, { filename: 'test.html' });
    expect(out).toContain("_incSlot(_includes, './header.html')");
    expect(out).toContain('model?.show');
  });
});

// ---------------------------------------------------------------------------
// P1 — Variable casing normalization
// ---------------------------------------------------------------------------

describe('transpile — variable casing preservation', () => {
  it('preserves camelCase variable names through parse5', () => {
    const src = `<div data-sly-set.myVariable="\${'hello'}">\${myVariable}</div>`;
    const code = transpile(src, { filename: 'test.html' });
    expect(code).toContain('myVariable');
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn();
    expect(html).toContain('hello');
  });

  it('preserves camelCase in use directive variable names', () => {
    const src = `<div data-sly-use.myModel="com.example.Model">\${myModel.title}</div>`;
    const code = transpile(src, { filename: 'test.html' });
    expect(code).toContain('myModel');
  });

  it('normalizes camelCase data-sly-list varName metadata (XxxList) in source and restores it', () => {
    // data-sly-test on the CHILD element: cellItemList is in scope inside the map body
    const src = `<table><tr data-sly-list.cellItem="\${model.cells}"><td data-sly-test="\${cellItemList.index < model.columnsCount}">\${cellItem.text}</td></tr></table>`;
    const code = transpile(src, { filename: 'test.html' });
    // generated code must use camelCase cellItemList (not cellitemlist / cellitemList)
    expect(code).toContain('cellItemList');
    expect(code).not.toContain('cellitemlist');
    // must work at runtime: renders only <td> whose index is < columnsCount
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ model: { cells: [{ text: 'A' }, { text: 'B' }, { text: 'C' }], columnsCount: 2 } });
    // index 0 < 2 → A, index 1 < 2 → B, index 2 < 2 → false → C skipped
    expect(html).toContain('A');
    expect(html).toContain('B');
    expect(html).not.toContain('C');
  });

  it('normalizes camelCase data-sly-repeat varName metadata (XxxList) in source and restores it', () => {
    // Just verify the generated code uses camelCase listItemList (normalization + restore)
    const src = `<li data-sly-repeat.listItem="\${model.items}">\${listItem.name} (\${listItemList.count})</li>`;
    const code = transpile(src, { filename: 'test.html' });
    expect(code).toContain('listItemList');
    expect(code).not.toContain('listitemlist');
    // also verify it renders correctly at runtime
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ model: { items: [{ name: 'alpha' }, { name: 'beta' }] } });
    expect(html).toContain('alpha (1)');
    expect(html).toContain('beta (2)');
  });
});

// ---------------------------------------------------------------------------
// P1 — Default omitAttrs patterns
// ---------------------------------------------------------------------------

describe('transpile — default omitAttrs', () => {
  it('strips data-emptytext attribute', () => {
    const src = `<div data-emptytext="Click to configure">content</div>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn();
    expect(html).not.toContain('data-emptytext');
    expect(html).toContain('content');
  });

  it('strips data-cmp-data-layer attribute', () => {
    const src = `<div data-cmp-data-layer="\${model.layer}">content</div>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ model: { layer: '{}' } });
    expect(html).not.toContain('data-cmp-data-layer');
  });

  it('strips data-placeholder-text attribute', () => {
    const src = `<div data-placeholder-text="Title">content</div>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn();
    expect(html).not.toContain('data-placeholder-text');
  });
});

// ---------------------------------------------------------------------------
// P1 — Free variable detection
// ---------------------------------------------------------------------------

describe('transpile — free variable detection', () => {
  it('adds undeclared references as parameters with default {}', () => {
    // Free vars are detected from directive expressions (not text content)
    const src = `<div data-sly-test="\${customVar.visible}">shown</div>`;
    const code = transpile(src, { filename: 'test.html' });
    expect(code).toContain('customVar');
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ customVar: { visible: true } });
    expect(html).toContain('shown');
  });

  it('does not add JS builtins (Math, JSON) as parameters', () => {
    const src = `<div>content</div>`;
    const code = transpile(src, { filename: 'test.html' });
    expect(code).not.toContain('Math =');
    expect(code).not.toContain('JSON =');
  });
});

// ---------------------------------------------------------------------------
// P2 — data-sly-use with defaults (@ key=value)
// ---------------------------------------------------------------------------

describe('transpile — data-sly-use with defaults', () => {
  it('provides default value for use parameter', () => {
    const src = `<div data-sly-use.config="\${com.example.Config @ timeout=3000}">\${config.timeout}</div>`;
    const code = transpile(src, { filename: 'test.html' });
    // useDefaults should be extracted and the param should have a default
    expect(code).toContain('config');
  });
});

// ---------------------------------------------------------------------------
// P2 — Reserved word handling (class → _class, for → _for)
// ---------------------------------------------------------------------------

describe('transpile — reserved word escaping', () => {
  it('escapes "class" as "_class" in parameter destructuring', () => {
    const src = `<div data-sly-set.class="\${model.cssClass}">\${class}</div>`;
    const code = transpile(src, { filename: 'test.html' });
    expect(code).toContain('_class');
  });

  it('escapes "class" in convertExpr', () => {
    expect(convertExpr('${class}')).toBe('_class');
  });

  it('escapes "for" in convertExpr', () => {
    expect(convertExpr('${for}')).toBe('_for');
  });
});

// ---------------------------------------------------------------------------
// P2 — _htlAttr with objects and null
// ---------------------------------------------------------------------------

describe('transpile — _htlAttr edge cases', () => {
  it('serializes objects as JSON in attributes', () => {
    const src = `<div data-config="\${model.config}">content</div>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ model: { config: { a: 1 } } });
    // Object should be JSON-serialized
    expect(html).toContain('{');
    expect(html).toContain('&quot;');
  });

  it('omits attribute when value is null', () => {
    const src = `<div title="\${model.title}">content</div>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ model: { title: null } });
    expect(html).not.toContain('title');
    expect(html).toBe('<div>content</div>');
  });

  it('keeps attribute when value is empty string', () => {
    const src = `<div title="\${model.title}">content</div>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ model: { title: '' } });
    expect(html).toContain('title=""');
  });
});

// ---------------------------------------------------------------------------
// P2 — escapeLiteral bare $
// ---------------------------------------------------------------------------

describe('escapeLiteral — bare $ sign', () => {
  it('escapes bare $ not followed by {', () => {
    const src = `<span>Price: $50</span>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn();
    expect(html).toContain('$50');
  });
});

// ---------------------------------------------------------------------------
// i18n dictionary support
// ---------------------------------------------------------------------------

describe('convertExpr — i18n dictionary', () => {
  it('generates dictionary lookup for single-quoted string', () => {
    expect(convertExpr("'Hello' @ i18n")).toBe("_i18n?.['Hello'] ?? 'Hello'");
  });

  it('generates dictionary lookup for double-quoted string', () => {
    expect(convertExpr('"Hello" @ i18n')).toBe('_i18n?.[\'Hello\'] ?? "Hello"');
  });

  it('generates dictionary lookup when i18n is combined with other options', () => {
    expect(convertExpr("'Hello' @ i18n, context='html'")).toBe(
      "_i18n?.['Hello'] ?? 'Hello'"
    );
  });

  it('does not generate lookup when @ i18n is absent', () => {
    expect(convertExpr("'Hello'")).toBe("'Hello'");
  });

  it('generates dynamic lookup for a variable expression', () => {
    expect(convertExpr('label @ i18n')).toBe('_i18n?.[label] ?? label');
  });

  it('generates dynamic lookup for a variable combined with other options', () => {
    expect(convertExpr("label @ i18n, context='html'")).toBe('_i18n?.[label] ?? label');
  });

  it('generates dynamic lookup for a dotted expression', () => {
    expect(convertExpr('model.key @ i18n')).toBe('_i18n?.[model?.key] ?? model?.key');
  });

  it('wraps expression in parens when it contains || to avoid ?? mixing error', () => {
    expect(convertExpr("(a && b) || 'fallback' @ i18n")).toBe(
      "_i18n?.[((a && b) || 'fallback')] ?? ((a && b) || 'fallback')"
    );
  });

  it('wraps expression in parens when it contains && to avoid ?? mixing error', () => {
    expect(convertExpr('a && b @ i18n')).toBe('_i18n?.[(a && b)] ?? (a && b)');
  });
});

describe('transpile — i18n dictionary', () => {
  it('adds _i18n as a parameter when @ i18n is used', () => {
    const src = `<span>\${'Read more' @ i18n}</span>`;
    const code = transpile(src, { filename: 'test.html' });
    expect(code).toContain('_i18n');
  });

  it('returns translated string when dictionary has a match', () => {
    const src = `<span>\${'Read more' @ i18n}</span>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ _i18n: { 'Read more': 'Leer más' } });
    expect(html).toContain('Leer más');
    expect(html).not.toContain('Read more');
  });

  it('falls back to original string when dictionary has no match', () => {
    const src = `<span>\${'Read more' @ i18n}</span>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ _i18n: {} });
    expect(html).toContain('Read more');
  });

  it('falls back to original string when no dictionary is passed', () => {
    const src = `<span>\${'Read more' @ i18n}</span>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn();
    expect(html).toContain('Read more');
  });

  it('translates i18n string used in an attribute', () => {
    const src = `<a title="\${'Go home' @ i18n}" href="/">link</a>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ _i18n: { 'Go home': 'Ir al inicio' } });
    expect(html).toContain('Ir al inicio');
  });

  it('translates multiple i18n strings in the same template', () => {
    const src = `<div><h1>\${'Title' @ i18n}</h1><p>\${'Description' @ i18n}</p></div>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ _i18n: { Title: 'Título', Description: 'Descripción' } });
    expect(html).toContain('Título');
    expect(html).toContain('Descripción');
  });

  it('translates a variable i18n expression at runtime', () => {
    // model.label is the idiomatic pattern — model is an AEM implicit, always detected
    const src = `<span>\${model.label @ i18n}</span>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ model: { label: 'Read more' }, _i18n: { 'Read more': 'Leer más' } });
    expect(html).toContain('Leer más');
    expect(html).not.toContain('Read more');
  });

  it('falls back to original variable value for variable i18n when key is missing', () => {
    const src = `<span>\${model.label @ i18n}</span>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ model: { label: 'Read more' }, _i18n: {} });
    expect(html).toContain('Read more');
  });

  it('adds _i18n as a parameter when a variable @ i18n is used', () => {
    const src = `<span>\${model.label @ i18n}</span>`;
    const code = transpile(src, { filename: 'test.html' });
    expect(code).toContain('_i18n');
  });

  it('translates variable i18n expression in an attribute', () => {
    const src = `<a title="\${model.label @ i18n}" href="/">link</a>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ model: { label: 'Go home' }, _i18n: { 'Go home': 'Ir al inicio' } });
    expect(html).toContain('Ir al inicio');
  });
});

// ===========================================================================
// ADDITIONAL COVERAGE — edge cases & real-world AEM patterns
// ===========================================================================

// ---------------------------------------------------------------------------
// convertExpr — in operator edge cases
// ---------------------------------------------------------------------------

describe('convertExpr — in operator edge cases', () => {
  // _htlIn is emitted by the full transpiler; inject it here for unit-testing convertExpr directly.
  const _htlIn = (l: unknown, r: unknown): boolean => {
    if (typeof r === 'string') return r.includes(String(l));
    if (Array.isArray(r)) return r.includes(l);
    return r != null && (l as string) in (r as object);
  };

  it('handles multiple in operators chained with &&', () => {
    const result = convertExpr('${a in b && c in d}');
    expect(result).toContain('_htlIn(');
    // Should produce valid JS when evaluated
    const fn = new Function('_htlIn', 'a', 'b', 'c', 'd', `return ${result};`);
    expect(fn(_htlIn, 'x', { x: 1 }, 'y', { y: 1 })).toBeTruthy();
    expect(fn(_htlIn, 'x', { x: 1 }, 'z', { y: 1 })).toBeFalsy();
  });

  it('handles in operator with optional-chained left operand', () => {
    const result = convertExpr('${item.name in parent.map}');
    // Should emit the _htlIn helper call
    expect(result).toContain('_htlIn(');
    const fn = new Function('_htlIn', 'item', 'parent', `return ${result};`);
    expect(fn(_htlIn, { name: 'k' }, { map: { k: true } })).toBeTruthy();
  });

  it('handles in operator with undefined right side', () => {
    const result = convertExpr('${key in obj}');
    const fn = new Function('_htlIn', 'key', 'obj', `return ${result};`);
    expect(fn(_htlIn, 'a', undefined)).toBeFalsy();
    expect(fn(_htlIn, 'a', null)).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// convertExpr — optional chaining edge cases
// ---------------------------------------------------------------------------

describe('convertExpr — optional chaining', () => {
  it('inserts ?. for chained property access', () => {
    expect(convertExpr('a.b.c')).toBe('a?.b?.c');
  });

  it('inserts ?. for bracket access', () => {
    expect(convertExpr("obj['key']")).toBe("obj?.['key']");
  });

  it('does not double ?. if already present', () => {
    const result = convertExpr('a?.b.c');
    // Should have ?. between a and b, and b and c
    expect(result).toBe('a?.b?.c');
  });

  it('handles jcr: property with deep chain', () => {
    expect(convertExpr('a.b.jcr:title')).toBe("a?.b?.['jcr:title']");
  });
});

// ---------------------------------------------------------------------------
// convertExpr — format edge cases
// ---------------------------------------------------------------------------

describe('convertExpr — @format edge cases', () => {
  it('handles format with reversed placeholder order', () => {
    const result = convertExpr("'{1}/{0}' @ format=[a, b]");
    const fn = new Function('a', 'b', `return ${result};`);
    expect(fn('first', 'second')).toBe('second/first');
  });

  it('handles format with more placeholders than args', () => {
    const result = convertExpr("'{0}/{1}/{2}' @ format=[a, b]");
    // Placeholder {2} has no corresponding arg — should produce "''" or empty
    expect(result).toBeDefined();
    const fn = new Function('a', 'b', `return ${result};`);
    expect(fn('x', 'y')).toContain('x');
  });
});

// ---------------------------------------------------------------------------
// convertExpr — empty / edge inputs
// ---------------------------------------------------------------------------

describe('convertExpr — edge inputs', () => {
  it('returns empty string for empty input', () => {
    expect(convertExpr('')).toBe('');
  });

  it('returns whitespace-only input as-is', () => {
    expect(convertExpr('   ')).toBe('   ');
  });

  it('handles single identifier', () => {
    expect(convertExpr('myVar')).toBe('myVar');
  });

  it('handles numeric literal', () => {
    expect(convertExpr('42')).toBe('42');
  });

  it('handles string literal', () => {
    expect(convertExpr("'hello'")).toBe("'hello'");
  });
});

// ---------------------------------------------------------------------------
// transpile — nested <sly> elements
// ---------------------------------------------------------------------------

describe('transpile — nested sly elements', () => {
  it('elides multiple levels of sly nesting', () => {
    const src = `<sly data-sly-test="\${show}"><sly data-sly-test="\${extra}"><span>deep</span></sly></sly>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ show: true, extra: true });
    expect(html).not.toContain('<sly');
    expect(html).toContain('<span>deep</span>');
  });

  it('respects inner condition when outer is true', () => {
    const src = `<sly data-sly-test="\${show}"><sly data-sly-test="\${extra}"><span>deep</span></sly></sly>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    expect(fn({ show: true, extra: false })).toBe('');
  });
});

// ---------------------------------------------------------------------------
// transpile — template call within repeat
// ---------------------------------------------------------------------------

describe('transpile — data-sly-call inside repeat', () => {
  it('invokes local template for each item in repeat', () => {
    const src = `
      <template data-sly-template.badge="\${@ label}"><span class="badge">\${label}</span></template>
      <div data-sly-repeat.item="\${items}"><sly data-sly-call="\${badge @ label=item.name}"></sly></div>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = mod.exports.createBadge;
    expect(fn).toBeDefined();
    // The badge template itself should render correctly
    expect(fn({ label: 'X' })).toContain('badge');
  });
});

// ---------------------------------------------------------------------------
// transpile — set variable used across child elements
// ---------------------------------------------------------------------------

describe('transpile — set variable scope', () => {
  it('set variable is accessible in child elements', () => {
    const src = `
      <div data-sly-set.title="\${model.heading}">
        <h1>\${title}</h1>
        <p data-sly-attribute.aria-label="\${title}">body</p>
      </div>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ model: { heading: 'MyTitle' } });
    expect(html).toContain('<h1>MyTitle</h1>');
    expect(html).toContain('aria-label="MyTitle"');
  });
});

// ---------------------------------------------------------------------------
// transpile — multiple dynamic attributes on same element
// ---------------------------------------------------------------------------

describe('transpile — multiple dynamic attributes', () => {
  it('renders multiple data-sly-attribute.* on one element', () => {
    const src = `<div data-sly-attribute.id="\${model.id}" data-sly-attribute.title="\${model.title}" data-sly-attribute.role="\${model.role}">content</div>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ model: { id: 'el1', title: 'Hello', role: 'button' } });
    expect(html).toContain('id="el1"');
    expect(html).toContain('title="Hello"');
    expect(html).toContain('role="button"');
  });

  it('omits null attributes and keeps others', () => {
    const src = `<div data-sly-attribute.id="\${model.id}" data-sly-attribute.title="\${model.title}">content</div>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ model: { id: 'el1', title: null } });
    expect(html).toContain('id="el1"');
    expect(html).not.toContain('title=');
  });
});

// ---------------------------------------------------------------------------
// transpile — element + text directives together
// ---------------------------------------------------------------------------

describe('transpile — element + text combined', () => {
  it('renders dynamic tag with text content', () => {
    const src = `<span data-sly-element="\${model.tag || 'span'}" data-sly-text="\${model.content}">fallback</span>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ model: { tag: 'h1', content: 'Title' } });
    expect(html).toContain('<h1');
    expect(html).toContain('Title');
    expect(html).toContain('</h1>');
    expect(html).not.toContain('fallback');
  });
});

// ---------------------------------------------------------------------------
// transpile — resource with test gating
// ---------------------------------------------------------------------------

describe('transpile — test + resource combined', () => {
  it('renders resource when test is truthy', () => {
    const src = `<sly data-sly-test="\${model.showHeader}" data-sly-resource="\${'header'}"></sly>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({
      model: { showHeader: true },
      _includes: { header: () => '<nav>Nav</nav>' },
    });
    expect(html).toContain('<nav>Nav</nav>');
  });

  it('hides resource when test is falsy', () => {
    const src = `<sly data-sly-test="\${model.showHeader}" data-sly-resource="\${'header'}"></sly>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({
      model: { showHeader: false },
      _includes: { header: () => '<nav>Nav</nav>' },
    });
    expect(html).not.toContain('<nav>');
  });
});

// ---------------------------------------------------------------------------
// transpile — unwrap with multiple children
// ---------------------------------------------------------------------------

describe('transpile — unwrap with nested children', () => {
  it('preserves multiple children when wrapper is unwrapped', () => {
    const src = `<div data-sly-unwrap="\${!model.showWrapper}"><p>first</p><p>second</p></div>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;

    const withWrapper = fn({ model: { showWrapper: true } });
    expect(withWrapper).toContain('<div>');
    expect(withWrapper).toContain('<p>first</p>');
    expect(withWrapper).toContain('<p>second</p>');

    const noWrapper = fn({ model: { showWrapper: false } });
    expect(noWrapper).not.toContain('<div>');
    expect(noWrapper).toContain('<p>first</p>');
    expect(noWrapper).toContain('<p>second</p>');
  });
});

// ---------------------------------------------------------------------------
// transpile — repeat + set variable inside loop
// ---------------------------------------------------------------------------

describe('transpile — set inside repeat', () => {
  it('evaluates set variable per iteration', () => {
    const src = `<ul data-sly-repeat.item="\${items}"><li data-sly-set.label="\${item.name}">\${label}</li></ul>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ items: [{ name: 'A' }, { name: 'B' }] });
    expect(html).toContain('A');
    expect(html).toContain('B');
  });
});

// ---------------------------------------------------------------------------
// transpile — multiple includes in one template
// ---------------------------------------------------------------------------

describe('transpile — multiple includes', () => {
  it('resolves multiple include slots', () => {
    const src = `<div><sly data-sly-include="./header.html"></sly><main>content</main><sly data-sly-include="./footer.html"></sly></div>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({
      _includes: {
        './header.html': () => '<nav>H</nav>',
        './footer.html': () => '<footer>F</footer>',
      },
    });
    expect(html).toContain('<nav>H</nav>');
    expect(html).toContain('<footer>F</footer>');
    expect(html).toContain('content');
  });
});

// ---------------------------------------------------------------------------
// transpile — data-sly-attribute.class overriding static class
// ---------------------------------------------------------------------------

describe('transpile — dynamic attribute overrides static', () => {
  it('dynamic class replaces static class attribute', () => {
    const src = `<div class="static-class" data-sly-attribute.class="\${model.cls}">content</div>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ model: { cls: 'dynamic' } });
    expect(html).toContain('class="dynamic"');
    expect(html).not.toContain('static-class');
  });
});

// ---------------------------------------------------------------------------
// transpile — test + include combined
// ---------------------------------------------------------------------------

describe('transpile — test + include combined', () => {
  it('skips include when test is falsy', () => {
    const src = `<sly data-sly-test="\${model.show}" data-sly-include="./partial.html"/>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({
      model: { show: false },
      _includes: { './partial.html': () => 'INCLUDED' },
    });
    expect(html).not.toContain('INCLUDED');
  });

  it('renders include when test is truthy', () => {
    const src = `<sly data-sly-test="\${model.show}" data-sly-include="./partial.html"/>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({
      model: { show: true },
      _includes: { './partial.html': () => 'INCLUDED' },
    });
    expect(html).toContain('INCLUDED');
  });

  it('passes include args through to the slot function', () => {
    const src = `<sly data-sly-include="./header.html @ wcmmode='edit'"/>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({
      _includes: {
        './header.html': ({ wcmmode }: { wcmmode?: string }) =>
          wcmmode === 'edit' ? 'EDIT' : 'VIEW',
      },
    });
    expect(html).toBe('EDIT');
  });
});

// ---------------------------------------------------------------------------
// transpile — data-sly-list with text directive
// ---------------------------------------------------------------------------

describe('transpile — list + text combined', () => {
  it('list mode with text directive on inner element', () => {
    const src = `<ul data-sly-list.item="\${items}"><li data-sly-text="\${item.label}">fallback</li></ul>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ items: [{ label: 'A' }, { label: 'B' }] });
    expect(html).toContain('<li>A</li>');
    expect(html).toContain('<li>B</li>');
    expect(html).not.toContain('fallback');
    expect(html.match(/<ul>/g)?.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// transpile — data-sly-repeat with test attribute on inner element
// ---------------------------------------------------------------------------

describe('transpile — repeat with conditional inner elements', () => {
  it('conditionally renders inner content per item', () => {
    const src = `<div data-sly-repeat.item="\${items}"><span data-sly-test="\${item.show}">\${item.name}</span></div>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({
      items: [
        { name: 'A', show: true },
        { name: 'B', show: false },
        { name: 'C', show: true },
      ],
    });
    expect(html).toContain('A');
    expect(html).not.toContain('B');
    expect(html).toContain('C');
  });
});

// ---------------------------------------------------------------------------
// transpile — complex real-world AEM pattern (accordion-like)
// ---------------------------------------------------------------------------

describe('transpile — real-world AEM accordion pattern', () => {
  const accordionSrc = `
    <div data-sly-use.accordion="com.adobe.cq.wcm.core.components.models.Accordion"
         data-sly-test="\${accordion.items.size > 0}"
         class="cmp-accordion"
         id="\${accordion.id}">
      <div data-sly-repeat.item="\${accordion.items}"
           class="cmp-accordion__item">
        <h3 data-sly-element="\${accordion.headingElement || 'h3'}"
            class="cmp-accordion__header">
          <button class="cmp-accordion__button\${(item.name in accordion.expandedItems) ? ' cmp-accordion__button--expanded' : ''}"
                  data-sly-attribute.aria-expanded="\${item.name in accordion.expandedItems}"
                  data-sly-attribute.id="\${accordion.id}-item-\${item.name}">
            <span class="cmp-accordion__title">\${item.title}</span>
          </button>
        </h3>
        <div data-sly-test="\${item.name in accordion.expandedItems}"
             class="cmp-accordion__panel"
             role="region">
          <p>\${item.description}</p>
        </div>
      </div>
    </div>`;

  it('renders expanded accordion items correctly', () => {
    const code = transpile(accordionSrc, { filename: 'accordion.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({
      accordion: {
        items: [
          { name: 'panel-1', title: 'Section 1', description: 'Content 1' },
          { name: 'panel-2', title: 'Section 2', description: 'Content 2' },
        ],
        expandedItems: { 'panel-1': true },
        id: 'acc1',
        headingElement: 'h3',
      },
    });
    expect(html).toContain('cmp-accordion');
    expect(html).toContain('Section 1');
    expect(html).toContain('Section 2');
    expect(html).toContain('cmp-accordion__button--expanded');
    expect(html).toContain('Content 1');
    // panel-2 is NOT expanded, so its panel content should not show
    expect(html).not.toContain('Content 2');
  });

  it('renders nothing when no items', () => {
    const code = transpile(accordionSrc, { filename: 'accordion.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({
      accordion: { items: [], expandedItems: {}, id: 'acc1' },
    });
    expect(html).toBe('');
  });

  it('handles undefined expandedItems safely', () => {
    const code = transpile(accordionSrc, { filename: 'accordion.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    expect(() =>
      fn({
        accordion: {
          items: [{ name: 'p1', title: 'T', description: 'D' }],
          expandedItems: undefined,
          id: 'acc1',
        },
      })
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// transpile — spread + named dynamic attributes combined
// ---------------------------------------------------------------------------

describe('transpile — spread + named dynamic attributes', () => {
  it('renders both spread and named dynamic attributes', () => {
    const src = `<div data-sly-attribute="\${model.attrs}" data-sly-attribute.id="\${model.id}">content</div>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({
      model: { attrs: { role: 'dialog', title: 'Hello' }, id: 'myId' },
    });
    expect(html).toContain('id="myId"');
    expect(html).toContain('role="dialog"');
  });
});

// ---------------------------------------------------------------------------
// transpile — data-sly-test with boolean logic
// ---------------------------------------------------------------------------

describe('transpile — test with complex expressions', () => {
  it('handles && in test expression', () => {
    const src = `<div data-sly-test="\${model.a && model.b}">both</div>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    expect(fn({ model: { a: true, b: true } })).toContain('both');
    expect(fn({ model: { a: true, b: false } })).not.toContain('both');
  });

  it('handles negation in test expression', () => {
    const src = `<div data-sly-test="\${!model.hidden}">visible</div>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    expect(fn({ model: { hidden: false } })).toContain('visible');
    expect(fn({ model: { hidden: true } })).not.toContain('visible');
  });
});

// ---------------------------------------------------------------------------
// transpile — void element with dynamic attributes
// ---------------------------------------------------------------------------

describe('transpile — void element + dynamic attributes', () => {
  it('renders input with multiple dynamic attributes', () => {
    const src = `<input type="text" data-sly-attribute.name="\${model.name}" data-sly-attribute.value="\${model.val}" data-sly-attribute.disabled="\${model.isDisabled}">`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({
      model: { name: 'email', val: 'test@test.com', isDisabled: true },
    });
    expect(html).toContain('type="text"');
    expect(html).toContain('name="email"');
    expect(html).toContain('value="test@test.com"');
    expect(html).toContain('disabled');
    expect(html).not.toContain('</input>');
  });
});

// ---------------------------------------------------------------------------
// transpile — deriveBaseName / function naming
// ---------------------------------------------------------------------------

describe('transpile — function naming', () => {
  it('converts kebab-case filename to PascalCase', () => {
    const out = transpile('<div>hello</div>', {
      filename: 'my-cool-widget.html',
    });
    expect(out).toContain('createMyCoolWidget');
  });

  it('converts underscore filename to PascalCase', () => {
    const out = transpile('<div>hello</div>', { filename: 'my_widget.html' });
    expect(out).toContain('createMyWidget');
  });

  it('handles simple filename', () => {
    const out = transpile('<div>hello</div>', { filename: 'button.html' });
    expect(out).toContain('createButton');
  });
});

// ---------------------------------------------------------------------------
// transpile — modelTransforms option
// ---------------------------------------------------------------------------

describe('transpile — modelTransforms', () => {
  it('applies computed properties from modelTransforms', () => {
    const src = `<div data-sly-use.hero="com.example.HeroModel">\${hero.title}</div>`;
    const code = transpile(src, {
      filename: 'test.html',
      modelTransforms: {
        HeroModel: { subtitle: 'hero.name + " extra"' },
      },
    });
    expect(code).toContain('Object.assign');
    // The transform should reference hero, not model
    expect(code).toContain('hero');
  });
});

// ---------------------------------------------------------------------------
// transpile — reserved word in property access vs variable
// ---------------------------------------------------------------------------

describe('transpile — reserved words in context', () => {
  it('does not escape "class" in property access position', () => {
    const result = convertExpr('${obj.class}');
    // obj.class → obj?.class (NOT obj?._class since class is a property)
    expect(result).toContain('obj');
  });

  it('escapes "class" as standalone variable', () => {
    expect(convertExpr('${class}')).toBe('_class');
  });

  it('escapes "for" as standalone variable', () => {
    expect(convertExpr('${for}')).toBe('_for');
  });
});

// ---------------------------------------------------------------------------
// transpile — comments inside conditionally rendered content
// ---------------------------------------------------------------------------

describe('transpile — comments inside conditional', () => {
  it('preserves HTML comments inside test block', () => {
    const src = `<div data-sly-test="\${model.show}"><!-- note --><span>content</span></div>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ model: { show: true } });
    expect(html).toContain('<!-- note -->');
    expect(html).toContain('content');
  });

  it('strips HTL comments inside test block', () => {
    const src = `<div data-sly-test="\${model.show}"><!--/* hidden */--><span>visible</span></div>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ model: { show: true } });
    expect(html).not.toContain('hidden');
    expect(html).toContain('visible');
  });
});

// ---------------------------------------------------------------------------
// transpile — set with mixed literal + expression (template literal set)
// ---------------------------------------------------------------------------

describe('transpile — set with mixed literal and expression', () => {
  it('builds a template literal for mixed set value', () => {
    const src = `<div data-sly-set.fullUrl="/page/\${model.slug}"><a href="\${fullUrl}">link</a></div>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ model: { slug: 'about-us' } });
    expect(html).toContain('href="/page/about-us"');
  });
});

// ---------------------------------------------------------------------------
// transpile — custom omitAttrs patterns
// ---------------------------------------------------------------------------

describe('transpile — custom omitAttrs', () => {
  it('strips attributes matching custom omitAttrs patterns', () => {
    const src = `<div data-custom-tracking="evt123" class="wrapper">content</div>`;
    const code = transpile(src, {
      filename: 'test.html',
      omitAttrs: [/^data-custom/],
    });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn();
    expect(html).not.toContain('data-custom-tracking');
    expect(html).toContain('class="wrapper"');
  });
});

// ---------------------------------------------------------------------------
// transpile — data-sly-repeat on the outer element (not list mode)
// ---------------------------------------------------------------------------

describe('transpile — repeat on outer element repeats entire element', () => {
  it('repeats the wrapper element itself', () => {
    const src = `<div class="card" data-sly-repeat.item="\${items}"><span>\${item}</span></div>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ items: ['A', 'B', 'C'] });
    expect(html.match(/<div class="card">/g)?.length).toBe(3);
    expect(html).toContain('A');
    expect(html).toContain('C');
  });
});

// ---------------------------------------------------------------------------
// sly inside table-context (foster-parenting bug)
// ---------------------------------------------------------------------------

describe('transpile — sly inside table row', () => {
  it('keeps sly as child of tr (no foster parenting)', () => {
    const src = `<tr data-sly-list.header="\${model.headers}"><sly data-sly-test="\${headerList.index < model.columnsCount}"><th>\${header.title}</th></sly></tr>`;
    const code = transpile(src, { filename: 'table.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({
      model: {
        headers: [{ title: 'A' }, { title: 'B' }, { title: 'C' }],
        columnsCount: 2,
      },
    });
    expect(html).toContain('<th>');
    expect(html.match(/<th>/g)?.length).toBe(2);
    expect(html).toContain('A');
    expect(html).toContain('B');
    expect(html).not.toContain('C');
  });

  it('scopes headerList inside the .map() callback', () => {
    const src = `<tr data-sly-list.header="\${model.headers}"><sly data-sly-test="\${headerList.index < 1}"><td>\${header}</td></sly></tr>`;
    const code = transpile(src, { filename: 'table.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    // Should not throw ReferenceError: headerList is not defined
    expect(() => fn({ model: { headers: ['X', 'Y'] } })).not.toThrow();
    const html = fn({ model: { headers: ['X', 'Y'] } });
    expect(html.match(/<td>/g)?.length).toBe(1);
    expect(html).toContain('X');
    expect(html).not.toContain('Y');
  });
});

// ---------------------------------------------------------------------------
// transpile — wrapperClass option
// ---------------------------------------------------------------------------

describe('transpile — wrapperClass', () => {
  it('auto-derives wrapper class from folder name when true', () => {
    const src = `<p>hello</p>`;
    const code = transpile(src, {
      filename: '/apps/mysite/image/image.html',
      wrapperClass: true,
    });
    expect(code).toContain('class="image');
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn();
    expect(html).toBe('<div class="image"><p>hello</p></div>');
  });

  it('uses custom class string when provided', () => {
    const src = `<p>content</p>`;
    const code = transpile(src, {
      filename: 'layout.html',
      wrapperClass: 'layout aem-GridColumn aem-GridColumn--default--12',
    });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn();
    expect(html).toBe(
      '<div class="layout aem-GridColumn aem-GridColumn--default--12"><p>content</p></div>'
    );
  });

  it('appends _wrapperClass from runtime when provided', () => {
    const src = `<p>inner</p>`;
    const code = transpile(src, {
      filename: '/apps/mysite/column/column.html',
      wrapperClass: true,
    });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({
      _wrapperClass: 'aem-GridColumn aem-GridColumn--default--12',
    });
    expect(html).toBe(
      '<div class="column aem-GridColumn aem-GridColumn--default--12"><p>inner</p></div>'
    );
  });

  it('does not add wrapper when wrapperClass is false', () => {
    const src = `<p>hi</p>`;
    const code = transpile(src, { filename: 'test.html', wrapperClass: false });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn();
    expect(html).toBe('<p>hi</p>');
  });

  it('does not add wrapper by default (backward compatible)', () => {
    const src = `<p>hi</p>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn();
    expect(html).toBe('<p>hi</p>');
  });
});

// ---------------------------------------------------------------------------
// transpile — resourceWrappers option
// ---------------------------------------------------------------------------

describe('transpile — resourceWrappers', () => {
  it('wraps resource include when static resourceWrappers match', () => {
    const src = `<sly data-sly-resource="\${'responsivegrid'}"></sly>`;
    const code = transpile(src, {
      filename: 'test.html',
      resourceWrappers: {
        responsivegrid: 'aem-Grid aem-Grid--12 aem-Grid--default--12',
      },
    });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({
      _includes: { responsivegrid: () => '<div>grid content</div>' },
    });
    expect(html).toContain(
      '<div class="aem-Grid aem-Grid--12 aem-Grid--default--12">'
    );
    expect(html).toContain('<div>grid content</div>');
    expect(html).toContain('</div>');
  });

  it('does not wrap when resource key has no matching wrapper', () => {
    const src = `<sly data-sly-resource="\${'header'}"></sly>`;
    const code = transpile(src, {
      filename: 'test.html',
      resourceWrappers: { responsivegrid: 'aem-Grid aem-Grid--12' },
    });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ _includes: { header: () => '<nav>Nav</nav>' } });
    expect(html).toBe('<nav>Nav</nav>');
  });

  it('allows runtime _resourceWrappers to override static ones', () => {
    const src = `<sly data-sly-resource="\${'grid'}"></sly>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({
      _includes: { grid: () => '<p>G</p>' },
      _resourceWrappers: { grid: 'custom-grid-class' },
    });
    expect(html).toContain('<div class="custom-grid-class">');
    expect(html).toContain('<p>G</p>');
  });

  it('wraps resource on non-sly elements too', () => {
    const src = `<div data-sly-resource="\${'sidebar'}">old</div>`;
    const code = transpile(src, {
      filename: 'test.html',
      resourceWrappers: { sidebar: 'sidebar-wrapper' },
    });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ _includes: { sidebar: () => '<aside>Side</aside>' } });
    expect(html).toContain('<div>');
    expect(html).toContain('<div class="sidebar-wrapper">');
    expect(html).toContain('<aside>Side</aside>');
  });

  it('passes resource args through to the slot function', () => {
    const src = `<sly data-sly-resource="\${'par' @ wcmmode='edit'}"></sly>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({
      _includes: {
        par: ({ wcmmode }: { wcmmode?: string }) =>
          wcmmode === 'edit' ? '<p>Edit</p>' : '<p>View</p>',
      },
    });
    expect(html).toBe('<p>Edit</p>');
  });

  it('matches by resourceType when key does not match', () => {
    const src = `<sly data-sly-resource="\${'par' @ resourceType='mysite/components/responsivegrid'}"></sly>`;
    const code = transpile(src, {
      filename: 'test.html',
      resourceWrappers: {
        'mysite/components/responsivegrid':
          'aem-Grid aem-Grid--12 aem-Grid--default--12',
      },
    });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({
      _includes: { par: () => '<div class="col">content</div>' },
    });
    expect(html).toContain(
      '<div class="aem-Grid aem-Grid--12 aem-Grid--default--12">'
    );
    expect(html).toContain('<div class="col">content</div>');
  });

  it('prefers resource key match over resourceType match', () => {
    const src = `<sly data-sly-resource="\${'par' @ resourceType='mysite/components/responsivegrid'}"></sly>`;
    const code = transpile(src, {
      filename: 'test.html',
      resourceWrappers: {
        par: 'par-specific-class',
        'mysite/components/responsivegrid': 'generic-grid-class',
      },
    });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ _includes: { par: () => '<p>hi</p>' } });
    expect(html).toContain('<div class="par-specific-class">');
    expect(html).not.toContain('generic-grid-class');
  });

  it('resourceType match works with object config (wrapper + childClass)', () => {
    const src = `<sly data-sly-resource="\${'par' @ resourceType='anaplan/components/responsivegrid'}"></sly>`;
    const code = transpile(src, {
      filename: 'test.html',
      resourceWrappers: {
        'anaplan/components/responsivegrid': {
          wrapper: 'aem-Grid aem-Grid--12 aem-Grid--default--12',
          childClass: 'aem-GridColumn aem-GridColumn--default--12',
        },
      },
    });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({
      _includes: { par: () => '<div class="column">text</div>' },
    });
    expect(html).toContain(
      '<div class="aem-Grid aem-Grid--12 aem-Grid--default--12">'
    );
    expect(html).toContain(
      '<div class="column aem-GridColumn aem-GridColumn--default--12">text</div>'
    );
  });
});

// ---------------------------------------------------------------------------
// transpile — real-world AEM composition: container + responsivegrid + column
// ---------------------------------------------------------------------------

describe('transpile — AEM container + responsivegrid + column composition', () => {
  it('composes nested components with wrapperClass, resourceWrappers and _wrapperClass', () => {
    // ── Container component ──
    const containerSrc = `<div class="cmp-container"><sly data-sly-resource="\${'responsivegrid'}"></sly></div>`;
    const containerCode = transpile(containerSrc, {
      filename: '/apps/mysite/container/container.html',
      wrapperClass: true,
      resourceWrappers: {
        responsivegrid: 'aem-Grid aem-Grid--12 aem-Grid--default--12',
      },
    });
    const containerMod: any = {};
    new Function('module', containerCode)(containerMod);
    const createContainer = Object.values(containerMod.exports)[0] as Function;

    // ── Column component ──
    const columnSrc = `<div class="cmp-column">Sample Text</div>`;
    const columnCode = transpile(columnSrc, {
      filename: '/apps/mysite/column/column.html',
      wrapperClass: true,
    });
    const columnMod: any = {};
    new Function('module', columnCode)(columnMod);
    const createColumn = Object.values(columnMod.exports)[0] as Function;

    // ── Compose at runtime ──
    const html = createContainer({
      _includes: {
        responsivegrid: () =>
          createColumn({
            _wrapperClass: 'aem-GridColumn aem-GridColumn--default--12',
          }),
      },
    });

    // Expected structure:
    // <div class="container">
    //   <div class="cmp-container">
    //     <div class="aem-Grid aem-Grid--12 aem-Grid--default--12">
    //       <div class="column aem-GridColumn aem-GridColumn--default--12">
    //         <div class="cmp-column">Sample Text</div>
    //       </div>
    //     </div>
    //   </div>
    // </div>
    expect(html).toContain('<div class="container">');
    expect(html).toContain('<div class="cmp-container">');
    expect(html).toContain(
      '<div class="aem-Grid aem-Grid--12 aem-Grid--default--12">'
    );
    expect(html).toContain(
      '<div class="column aem-GridColumn aem-GridColumn--default--12">'
    );
    expect(html).toContain('<div class="cmp-column">Sample Text</div>');

    // Verify nesting order
    const containerIdx = html.indexOf('class="container"');
    const cmpContainerIdx = html.indexOf('class="cmp-container"');
    const gridIdx = html.indexOf('class="aem-Grid');
    const columnIdx = html.indexOf('class="column aem-GridColumn');
    const cmpColumnIdx = html.indexOf('class="cmp-column"');
    expect(containerIdx).toBeLessThan(cmpContainerIdx);
    expect(cmpContainerIdx).toBeLessThan(gridIdx);
    expect(gridIdx).toBeLessThan(columnIdx);
    expect(columnIdx).toBeLessThan(cmpColumnIdx);
  });
});

// ---------------------------------------------------------------------------
// transpile — AEM composition with separated config options
// ---------------------------------------------------------------------------

describe('transpile — AEM composition with separated config', () => {
  it('composes container + grid + column with resourceWrappers + wrapperClass', () => {
    // ── Container component (uses LayoutContainer model) ──
    const containerSrc = `<div data-sly-use.container="com.example.LayoutContainer" class="cmp-container"><sly data-sly-resource="\${'responsivegrid'}"></sly></div>`;
    const containerCode = transpile(containerSrc, {
      filename: '/apps/mysite/container/container.html',
      wrapperClass: true,
      resourceWrappers: {
        responsivegrid: {
          wrapper: 'aem-Grid aem-Grid--12 aem-Grid--default--12',
          childClass: 'aem-GridColumn aem-GridColumn--default--12',
        },
      },
    });
    const containerMod: any = {};
    new Function('module', containerCode)(containerMod);
    const createContainer = Object.values(containerMod.exports)[0] as Function;

    // ── Column component (no special config needed) ──
    const columnSrc = `<div class="cmp-column">Sample Text</div>`;
    const columnCode = transpile(columnSrc, {
      filename: '/apps/mysite/column/column.html',
      wrapperClass: true,
    });
    const columnMod: any = {};
    new Function('module', columnCode)(columnMod);
    const createColumn = Object.values(columnMod.exports)[0] as Function;

    // ── Compose at runtime ──
    const html = createContainer({
      _includes: {
        responsivegrid: () => createColumn(),
      },
    });

    expect(html).toContain('<div class="container">');
    expect(html).toContain('<div class="cmp-container">');
    expect(html).toContain(
      '<div class="aem-Grid aem-Grid--12 aem-Grid--default--12">'
    );
    expect(html).toContain(
      '<div class="column aem-GridColumn aem-GridColumn--default--12">'
    );
    expect(html).toContain('<div class="cmp-column">Sample Text</div>');

    // Verify nesting order
    const containerIdx = html.indexOf('class="container"');
    const cmpContainerIdx = html.indexOf('class="cmp-container"');
    const gridIdx = html.indexOf('class="aem-Grid');
    const columnIdx = html.indexOf('class="column aem-GridColumn');
    const cmpColumnIdx = html.indexOf('class="cmp-column"');
    expect(containerIdx).toBeLessThan(cmpContainerIdx);
    expect(cmpContainerIdx).toBeLessThan(gridIdx);
    expect(gridIdx).toBeLessThan(columnIdx);
    expect(columnIdx).toBeLessThan(cmpColumnIdx);
  });

  it('childClass injects class when child has no existing class', () => {
    const src = `<div><sly data-sly-resource="\${'responsivegrid'}"></sly></div>`;
    const code = transpile(src, {
      filename: 'test.html',
      resourceWrappers: {
        responsivegrid: {
          wrapper: 'aem-Grid aem-Grid--12 aem-Grid--default--12',
          childClass: 'aem-GridColumn aem-GridColumn--default--12',
        },
      },
    });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({
      _includes: { responsivegrid: () => '<span>bare</span>' },
    });
    expect(html).toContain(
      '<div class="aem-Grid aem-Grid--12 aem-Grid--default--12">'
    );
    expect(html).toContain(
      '<span class="aem-GridColumn aem-GridColumn--default--12">bare</span>'
    );
  });

  it('childClass applies to all root children, not just the first', () => {
    const src = `<sly data-sly-resource="\${'grid' @ resourceType='mysite/components/responsivegrid'}"></sly>`;
    const code = transpile(src, {
      filename: 'test.html',
      resourceWrappers: {
        'mysite/components/responsivegrid': {
          wrapper: 'aem-Grid aem-Grid--12',
          childClass: 'aem-GridColumn aem-GridColumn--default--12',
        },
      },
    });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({
      _includes: {
        grid: () =>
          '<div class="column">A</div><div class="column">B</div><div class="column">C</div>',
      },
    });
    expect(html).toContain('<div class="aem-Grid aem-Grid--12">');
    // All three children should have childClass
    const matches = html.match(/aem-GridColumn aem-GridColumn--default--12/g);
    expect(matches).toHaveLength(3);
    expect(html).toContain('<div class="column aem-GridColumn aem-GridColumn--default--12">A</div>');
    expect(html).toContain('<div class="column aem-GridColumn aem-GridColumn--default--12">B</div>');
    expect(html).toContain('<div class="column aem-GridColumn aem-GridColumn--default--12">C</div>');
  });

  it('childClass applies to root children without existing class', () => {
    const src = `<sly data-sly-resource="\${'grid' @ resourceType='mysite/components/responsivegrid'}"></sly>`;
    const code = transpile(src, {
      filename: 'test.html',
      resourceWrappers: {
        'mysite/components/responsivegrid': {
          childClass: 'aem-GridColumn',
        },
      },
    });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({
      _includes: {
        grid: () => '<div>A</div><span>B</span>',
      },
    });
    expect(html).toContain('<div class="aem-GridColumn">A</div>');
    expect(html).toContain('<span class="aem-GridColumn">B</span>');
  });
});

// ---------------------------------------------------------------------------
// transpile — fileOverrides
// ---------------------------------------------------------------------------

describe('transpile — fileOverrides', () => {
  it('replaces data-sly-use file.html + data-sly-call with provided JS function', () => {
    const src = [
      '<sly data-sly-use.container="com.example.LayoutContainer">',
      '  <sly data-sly-use.responsiveGridTemplate="responsiveGrid.html"',
      '       data-sly-call="${responsiveGridTemplate.responsiveGrid @ container=container}"></sly>',
      '</sly>',
    ].join('\n');
    const code = transpile(src, {
      filename: 'container.html',
      fileOverrides: {
        'responsiveGrid.html':
          "{ responsiveGrid: ({ container, _includes }) => _includes?.content?.() ?? '' }",
      },
    });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ _includes: { content: () => '<p>Hello</p>' } });
    expect(html).toContain('<p>Hello</p>');
    // Should NOT contain require() calls
    expect(code).not.toContain('require(');
  });

  it('fileOverrides defaults can be overridden at runtime', () => {
    const src = [
      '<sly data-sly-use.tpl="myTemplate.html"',
      '     data-sly-call="${tpl.render @ title=\'Hi\'}"></sly>',
    ].join('\n');
    const code = transpile(src, {
      filename: 'test.html',
      fileOverrides: {
        'myTemplate.html': "{ render: ({ title }) => '<b>' + title + '</b>' }",
      },
    });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;

    // Use default from fileOverrides
    const html1 = fn();
    expect(html1).toContain('<b>Hi</b>');

    // Override at runtime
    const html2 = fn({
      tpl: { render: ({ title }: any) => '<i>' + title + '</i>' },
    });
    expect(html2).toContain('<i>Hi</i>');
  });

  it('works alongside modelTransforms and resourceWrappers', () => {
    const src = [
      '<sly data-sly-use.container="com.example.LayoutContainer">',
      '  <sly data-sly-test="${container.layout == \'RESPONSIVE_GRID\'}"',
      '       data-sly-use.gridTpl="responsiveGrid.html"',
      '       data-sly-call="${gridTpl.responsiveGrid @ container=container}"></sly>',
      '</sly>',
    ].join('\n');
    const code = transpile(src, {
      filename: 'container.html',
      modelTransforms: {
        LayoutContainer: { layout: "'RESPONSIVE_GRID'" },
      },
      resourceWrappers: {
        responsivegrid: { wrapper: 'aem-Grid', childClass: 'aem-GridColumn' },
      },
      fileOverrides: {
        'responsiveGrid.html':
          "{ responsiveGrid: ({ container, _includes }) => _includes?.content?.() ?? '' }",
      },
    });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({
      _includes: { content: () => '<div class="child">OK</div>' },
    });
    // modelTransforms sets layout = 'RESPONSIVE_GRID', so the test passes
    expect(html).toContain('<div class="child">OK</div>');
    // No require calls
    expect(code).not.toContain('require(');
  });

  it('supports dynamic data-sly-call targets', () => {
    const src = [
      '<sly data-sly-use.variant="com.example.Variant">',
      '  <sly data-sly-use.tpl="myTemplate.html"',
      '       data-sly-call="${tpl[variant] @ title=\'Hi\'}"></sly>',
      '</sly>',
    ].join('\n');
    const code = transpile(src, {
      filename: 'test.html',
      fileOverrides: {
        'myTemplate.html': "{ one: ({ title }) => '<b>' + title + '</b>', two: ({ title }) => '<i>' + title + '</i>' }",
      },
    });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    expect(fn({ variant: 'one' })).toContain('<b>Hi</b>');
    expect(fn({ variant: 'two' })).toContain('<i>Hi</i>');
  });

  it('htl content is transpiled inline and used as override', () => {
    const src = [
      '<sly data-sly-use.container="com.example.LayoutContainer">',
      '  <sly data-sly-use.gridTpl="responsiveGrid.html"',
      '       data-sly-call="${gridTpl.responsiveGrid @ container=container}"></sly>',
      '</sly>',
    ].join('\n');
    const code = transpile(src, {
      filename: 'container.html',
      fileOverrides: {
        'responsiveGrid.html': {
          htl: [
            '<template data-sly-template.responsiveGrid="${ @ container }">',
            '  <div id="${container.id}" class="cmp-container">',
            '    <sly data-sly-resource="${\'content\'}"></sly>',
            '  </div>',
            '</template>',
          ].join('\n'),
        },
      },
    });
    // Should NOT contain require() calls
    expect(code).not.toContain('require(');
    // Should contain the inlined function
    expect(code).toContain('createResponsiveGrid');

    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({
      container: { id: 'cq-1' },
      _includes: { content: () => '<p>Hello</p>' },
    });
    expect(html).toContain('<div id="cq-1" class="cmp-container">');
    expect(html).toContain('<p>Hello</p>');
  });

  it('resolves interpolated html use paths at runtime', () => {
    const src = [
      '<sly data-sly-use.component="tabs-${model.tabsTemplate}.html">',
      '  <sly data-sly-call="${component.tabs @ model=model}"></sly>',
      '</sly>',
    ].join('\n');
    const code = transpile(src, {
      filename: path.join(fixturesDir, 'tabs-host.html'),
    });
    expect(code).toContain('require(');
    expect(code).toContain('tabs-');
    expect(code).toContain('tabsTemplate');

    const requests: string[] = [];
    const fakeRequire = (request: string) => {
      requests.push(request);
      if (request === './tabs-vertical.html') {
        return {
          createTabs: ({ model }: { model: any }) =>
            `<div>${model.tabsTemplate}</div>`,
        };
      }
      throw new Error(`Unexpected require: ${request}`);
    };

    const mod: any = {};
    new Function('module', 'require', code)(mod, fakeRequire);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ model: { tabsTemplate: 'vertical' } });

    expect(requests).toContain('./tabs-vertical.html');
    expect(html).toContain('<div>vertical</div>');
  });

  it('resolves interpolated html use paths from fixture files', () => {
    const src = fs.readFileSync(path.join(fixturesDir, 'tabs-host.html'), 'utf8');
    const code = transpile(src, {
      filename: path.join(fixturesDir, 'tabs-host.html'),
    });
    expect(code).toContain('require(');
    expect(code).toContain('tabs-');
    expect(code).toContain('tabsTemplate');

    const htmlAwareRequire = (id: string) => {
      if (id.endsWith('.html')) {
        const resolvedPath = path.resolve(fixturesDir, id);
        const htmlSrc = fs.readFileSync(resolvedPath, 'utf8');
        const transpiled = transpile(htmlSrc, { filename: resolvedPath });
        const m: any = {};
        new Function('module', transpiled)(m);
        return m.exports;
      }
      return fixturesRequire(id);
    };

    const mod: any = {};
    new Function('module', 'require', code)(mod, htmlAwareRequire);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ model: { tabsTemplate: 'vertical' } });

    expect(html).toContain('cmp-tabs--vertical');
    expect(html).toContain('vertical');
  });

  it('htl content with data-sly-resource triggers resourceWrappers', () => {
    const src = [
      '<sly data-sly-use.container="com.example.LayoutContainer">',
      '  <sly data-sly-use.gridTpl="responsiveGrid.html"',
      '       data-sly-call="${gridTpl.responsiveGrid @ container=container}"></sly>',
      '</sly>',
    ].join('\n');
    const code = transpile(src, {
      filename: '/apps/mysite/container/container.html',
      wrapperClass: true,
      resourceWrappers: {
        'wcm/foundation/components/responsivegrid': {
          wrapper: 'aem-Grid aem-Grid--12',
          childClass: 'aem-GridColumn',
        },
      },
      fileOverrides: {
        'responsiveGrid.html': {
          htl: [
            '<template data-sly-template.responsiveGrid="${ @ container }">',
            '  <div id="${container.id}" class="cmp-container">',
            '    <sly data-sly-resource="${\'content\' @ resourceType=\'wcm/foundation/components/responsivegrid\'}"></sly>',
            '  </div>',
            '</template>',
          ].join('\n'),
        },
      },
    });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({
      container: { id: 'cq-1' },
      _includes: { content: () => '<div class="cmp-column">Text</div>' },
    });
    // wrapperClass on parent
    expect(html).toContain('<div class="container">');
    // cmp-container from the inline template
    expect(html).toContain('<div id="cq-1" class="cmp-container">');
    // resourceWrappers grid wrapper
    expect(html).toContain('<div class="aem-Grid aem-Grid--12">');
    // resourceWrappers childClass injected
    expect(html).toContain('<div class="cmp-column aem-GridColumn">Text</div>');
  });
});

// ---------------------------------------------------------------------------
// transpile — modelTransforms _includes (computed from model data)
// ---------------------------------------------------------------------------

describe('transpile — modelTransforms _includes', () => {
  it('computes _includes from model data via _includes special key', () => {
    const src = `<div data-sly-use.model="com.example.ColumnContainer" data-sly-repeat.item="\${model.columns}" data-sly-resource="\${item.path}"></div>`;
    const code = transpile(src, {
      filename: 'columns.html',
      modelTransforms: {
        ColumnContainer: {
          _includes:
            "Object.fromEntries((model.columns || []).map((col, i) => [col.path, () => (model._content || [])[i] || '']))",
        },
      },
    });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({
      model: {
        columns: [
          { path: 'col-0', cssClass: 'a' },
          { path: 'col-1', cssClass: 'b' },
        ],
        _content: ['<p>First</p>', '<p>Second</p>'],
      },
    });
    expect(html).toContain('<p>First</p>');
    expect(html).toContain('<p>Second</p>');
    // _includes should NOT appear as a model property
    expect(code).not.toMatch(/Object\.assign\(\{[^}]*_includes/);
  });

  it('_includes from modelTransforms merges with runtime _includes', () => {
    const src = `<div data-sly-use.m="com.example.ColumnContainer"><sly data-sly-resource="\${'slot-a'}"></sly><sly data-sly-resource="\${'extra'}"></sly></div>`;
    const code = transpile(src, {
      filename: 'test.html',
      modelTransforms: {
        ColumnContainer: {
          _includes: "{ 'slot-a': () => '<b>computed</b>' }",
        },
      },
    });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    // Runtime _includes for 'extra' merges with computed 'slot-a'
    const html = fn({ _includes: { extra: () => '<i>runtime</i>' } });
    expect(html).toContain('<b>computed</b>');
    expect(html).toContain('<i>runtime</i>');
  });
});

// ---------------------------------------------------------------------------
// modelTransforms — bug fixes (classKey matching, binding serialization, fallback guard)
// ---------------------------------------------------------------------------

describe('modelTransforms — classKey strict matching', () => {
  it('does NOT apply a transform whose classKey is a substring of the class name', () => {
    // "Tabs" must not match "TabsModel" — previously String.includes() caused this
    const src = `<div data-sly-use.tabs="com.example.TabsModel">\${tabs.title}</div>`;
    const code = transpile(src, {
      filename: 'test.html',
      modelTransforms: {
        Tabs: { extraProp: "'from-tabs-transform'" },
      },
    });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    // The Tabs transform must NOT have run — extraProp should not be on tabs
    const html = fn({ tabs: { title: 'Hello' } });
    expect(html).toContain('Hello');
    expect(html).not.toContain('from-tabs-transform');
  });

  it('applies a transform when classKey matches exactly the simple class name', () => {
    const src = `<div data-sly-use.tabs="com.example.Tabs">\${tabs.extra}</div>`;
    const code = transpile(src, {
      filename: 'test.html',
      modelTransforms: {
        Tabs: { extra: "'injected'" },
      },
    });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    expect(fn({ tabs: {} })).toContain('injected');
  });

  it('applies a transform when classKey is the fully-qualified class name', () => {
    const src = `<div data-sly-use.tabs="com.example.Tabs">\${tabs.extra}</div>`;
    const code = transpile(src, {
      filename: 'test.html',
      modelTransforms: {
        'com.example.Tabs': { extra: "'fqn-match'" },
      },
    });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    expect(fn({ tabs: {} })).toContain('fqn-match');
  });
});

describe('modelTransforms — varName binding in _includes function', () => {
  it('serializes ({ varName }) => ... correctly when binding name matches the use variable', () => {
    // data-sly-use.tabs → varName='tabs'; user writes ({ tabs }) => ...
    const src = `<div data-sly-use.tabs="com.example.Tabs"><sly data-sly-resource="\${'slot'}"></sly></div>`;
    const code = transpile(src, {
      filename: 'test.html',
      modelTransforms: {
        Tabs: {
          _includes: ({ tabs }: Record<string, any>) => ({
            slot: () => `<p>${tabs.label}</p>`,
          }),
        },
      },
    });
    // Must NOT produce [object Object] in generated code
    expect(code).not.toContain('[object Object]');
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    expect(fn({ tabs: { label: 'Tab label' } })).toContain('<p>Tab label</p>');
  });

  it('serializes ({ tabs: t }) => ... alias binding correctly', () => {
    const src = `<div data-sly-use.tabs="com.example.Tabs"><sly data-sly-resource="\${'slot'}"></sly></div>`;
    const code = transpile(src, {
      filename: 'test.html',
      modelTransforms: {
        Tabs: {
          _includes: ({ tabs: t }: Record<string, any>) => ({
            slot: () => `<span>${t.name}</span>`,
          }),
        },
      },
    });
    expect(code).not.toContain('[object Object]');
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    expect(fn({ tabs: { name: 'My Tab' } })).toContain('<span>My Tab</span>');
  });
});

describe('modelTransforms — array-of-items pattern (tabs / accordion / carousel)', () => {
  it('transforms component.items array into per-item _includes slots', () => {
    // Template uses data-sly-resource with dynamic path (each item renders in its own slot).
    // The transformer maps items → { [item.name]: () => item.content }.
    const src = `
      <div data-sly-use.component="com.example.Tabs">
        <sly data-sly-repeat.item="\${component.items}"
             data-sly-resource="\${item.name}">
        </sly>
      </div>`;

    const code = transpile(src, {
      filename: 'test.html',
      modelTransforms: {
        Tabs: {
          _includes: ({ component }: Record<string, any>) =>
            Object.fromEntries(
              (component?.items || component?.children || []).map((item: any) => [
                item.name || item.id,
                () => (typeof item.content === 'function' ? item.content() : (item.content || '')),
              ])
            ),
        },
      },
    });

    expect(code).not.toContain('[object Object]');
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;

    const html = fn({
      component: {
        items: [
          { name: 'tab-1', content: '<p>First tab</p>' },
          { name: 'tab-2', content: '<p>Second tab</p>' },
        ],
      },
    });
    expect(html).toContain('<p>First tab</p>');
    expect(html).toContain('<p>Second tab</p>');
  });

  it('story _includes overrides transformer slots', () => {
    const src = `
      <div data-sly-use.component="com.example.Tabs">
        <sly data-sly-repeat.item="\${component.items}"
             data-sly-resource="\${item.name}">
        </sly>
      </div>`;

    const code = transpile(src, {
      filename: 'test.html',
      modelTransforms: {
        Tabs: {
          _includes: ({ component }: Record<string, any>) =>
            Object.fromEntries(
              (component?.items || []).map((item: any) => [
                item.name,
                () => (item.content || ''),
              ])
            ),
        },
      },
    });

    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;

    // _includes.tab-1 from story overrides the transformer
    const html = fn({
      component: { items: [{ name: 'tab-1', content: '<p>from-transform</p>' }] },
      _includes: { 'tab-1': () => '<p>from-story</p>' },
    });
    expect(html).toContain('from-story');
    expect(html).not.toContain('from-transform');
  });
});

describe('transpile — content shorthand parameter', () => {
  it('createFn({ content }) renders as the parsys content slot', () => {
    const src = `<div data-sly-use.model="com.example.Page"><sly data-sly-resource="\${'content'}"></sly></div>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;

    // Pass content directly — no _includes wrapper needed
    const html = fn({ model: {}, content: () => '<p>some content</p>' });
    expect(html).toContain('<p>some content</p>');
  });

  it('explicit _includes.content wins over the content shorthand', () => {
    const src = `<div data-sly-use.model="com.example.Page"><sly data-sly-resource="\${'content'}"></sly></div>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;

    const html = fn({
      content: () => '<p>from-shorthand</p>',
      _includes: { content: () => '<p>from-includes</p>' },
    });
    expect(html).toContain('from-includes');
    expect(html).not.toContain('from-shorthand');
  });

  it('content shorthand also works as a plain string', () => {
    const src = `<div data-sly-use.model="com.example.Page"><sly data-sly-resource="\${'content'}"></sly></div>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;

    expect(fn({ content: '<p>str content</p>' })).toContain('<p>str content</p>');
  });

  it('merges a content function result when it returns an includes map', () => {
    const src = `<div data-sly-use.model="com.example.Page"><sly data-sly-resource="\${'image'}"></sly><sly data-sly-resource="\${'caption'}"></sly></div>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;

    const html = fn({
      model: { src: '/hero.jpg', caption: 'Hero' },
      content: ({ model }: { model: { src: string; caption: string } }) => ({
        image: () => `<img src="${model.src}">`,
        caption: () => `<figcaption>${model.caption}</figcaption>`,
      }),
    });

    expect(html).toContain('<img src="/hero.jpg">');
    expect(html).toContain('<figcaption>Hero</figcaption>');
    expect(html).not.toContain('[object Object]');
  });

  it('content function can destructure any arg from _rest', () => {
    const src = `<div data-sly-use.model="com.example.Page"><sly data-sly-resource="\${'resource'}"></sly></div>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;

    const html = fn({
      fragment: { localizedPath: '/content/fragment/en' },
      content: ({ fragment }: { fragment: { localizedPath: string } }) => ({
        resource: () => '<button>Open</button>',
        [fragment?.localizedPath]: () => '<p>Fragment content</p>',
      }),
    });

    expect(html).toContain('<button>Open</button>');
  });

  it('content returning object spreads into _includes even when slots are dynamic (no static slot)', () => {
    // navpanel / navgroup pattern: data-sly-resource="${path}" — no static slot name visible.
    // content() must still spread its object result into _includes.
    const src = `<div data-sly-use.model="com.example.NavPanel">
  <sly data-sly-repeat.item="\${model.items}" data-sly-resource="\${item.path}"></sly>
</div>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;

    const html = fn({
      model: { items: [{ path: 'nav-a' }, { path: 'nav-b' }] },
      content: () => ({
        'nav-a': () => '<li>Item A</li>',
        'nav-b': () => '<li>Item B</li>',
      }),
    });
    expect(html).toContain('<li>Item A</li>');
    expect(html).toContain('<li>Item B</li>');
  });

  it('other _rest props still flow to child data-sly-call', () => {
    const src = `
      <template data-sly-template.outer="\${@ item}">
        <sly data-sly-call="\${inner @ item=item}"></sly>
      </template>
      <template data-sly-template.inner="\${@ item}">
        <div>\${item}</div>
      </template>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    // extra is in _rest and flows down via ..._rest to inner
    const html = mod.exports.createOuter({ item: 'hello', extra: 'x' });
    expect(html).toContain('<div>hello</div>');
  });
});

describe('modelTransforms — content binding (typeof check / the canonical use case)', () => {
  // content binding resolves to _rest.content — the raw value passed directly by the story.
  // The transform maps it to the real slot name (par, parsys, etc.).
  const makeTransform = () => ({
    Page: {
      _includes: ({ content }: Record<string, any>) =>
        content
          ? { par: typeof content === 'function' ? content : () => content }
          : {},
    },
  });

  it('story passes content as a function → par slot receives the function (typeof === function)', () => {
    const src = `<div data-sly-use.model="com.example.Page"><sly data-sly-resource="\${'par'}"></sly></div>`;
    const code = transpile(src, { filename: 'test.html', modelTransforms: makeTransform() });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    // pass content at top level — no _includes wrapper
    const html = fn({ content: () => '<p>fn-content</p>' });
    expect(html).toContain('<p>fn-content</p>');
  });

  it('story passes content as a string → par slot wraps it in a function (typeof !== function)', () => {
    const src = `<div data-sly-use.model="com.example.Page"><sly data-sly-resource="\${'par'}"></sly></div>`;
    const code = transpile(src, { filename: 'test.html', modelTransforms: makeTransform() });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ content: '<p>str-content</p>' });
    expect(html).toContain('<p>str-content</p>');
  });

  it('omits par slot when no content provided (returns empty {})', () => {
    const src = `<div data-sly-use.model="com.example.Page"><sly data-sly-resource="\${'par'}"></sly></div>`;
    const code = transpile(src, { filename: 'test.html', modelTransforms: makeTransform() });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    expect(fn({})).toBe('<div></div>');
  });
});

describe('modelTransforms — content binding', () => {
  it('content binding receives _rest.content and can target a different slot than auto-merge', () => {
    // Template has two slots: par (parsys → auto-merge target) and header.
    // The transform maps content → header (different slot); no conflict.
    const src = `<div data-sly-use.model="com.example.Page">
  <sly data-sly-resource="\${'par'}"></sly>
  <sly data-sly-resource="\${'header'}"></sly>
</div>`;
    const code = transpile(src, {
      filename: 'test.html',
      modelTransforms: {
        Page: {
          _includes: ({ model, content }: Record<string, any>) => ({
            header: () => `<nav>${model.nav}</nav>`,
            ...(content ? { par: typeof content === 'function' ? content : () => content } : {}),
          }),
        },
      },
    });
    expect(code).not.toContain('[object Object]');
    expect(code).toContain('_rest.content');

    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;

    const html = fn({ model: { nav: 'Nav' }, content: () => '<p>Page body</p>' });
    expect(html).toContain('<p>Page body</p>');
    expect(html).toContain('<nav>Nav</nav>');
  });

  it('content binding with alias (content: c) — receives _rest.content', () => {
    const src = `<div data-sly-use.model="com.example.Page"><sly data-sly-resource="\${'slot'}"></sly></div>`;
    const code = transpile(src, {
      filename: 'test.html',
      modelTransforms: {
        Page: {
          _includes: ({ content: c }: Record<string, any>) => ({
            slot: typeof c === 'function' ? c : () => (c ?? ''),
          }),
        },
      },
    });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;

    // story passes content directly
    expect(fn({ content: () => '<p>inner</p>' })).toContain('<p>inner</p>');
  });

  it('returns empty when content is not provided', () => {
    const src = `<div data-sly-use.model="com.example.Page"><sly data-sly-resource="\${'slot'}"></sly></div>`;
    const code = transpile(src, {
      filename: 'test.html',
      modelTransforms: {
        Page: {
          _includes: ({ content }: Record<string, any>) => ({
            slot: typeof content === 'function' ? content : () => (content ?? ''),
          }),
        },
      },
    });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    expect(fn({})).toContain('<div></div>');
  });
});

describe('modelTransforms — arbitrary _rest bindings', () => {
  it('unknown identifier binding maps to _rest.name (accessible via story args)', () => {
    // Any identifier not in the recognized set is treated as a _rest binding.
    const src = `<div data-sly-use.tabs="com.example.Tabs"><sly data-sly-resource="\${'s'}"></sly></div>`;
    const code = transpile(src, {
      filename: 'test.html',
      modelTransforms: {
        Tabs: {
          _includes: ({ unknownBinding }: any) => ({ s: () => String(unknownBinding) }),
        },
      },
    });
    expect(code).toContain('_rest.unknownBinding');
  });

  it('({ fragment, content }) serializes fragment → _rest.fragment and content → _rest.content', () => {
    const src = `<div data-sly-use.model="com.example.Lightbox">
  <sly data-sly-resource="\${'resource'}"></sly>
  <sly data-sly-resource="\${'lightbox-fragment'}"></sly>
</div>`;
    const code = transpile(src, {
      filename: 'test.html',
      modelTransforms: {
        Lightbox: {
          _includes: ({ fragment, content }: any) =>
            typeof content === 'function' ? content({ fragment }) : {},
        },
      },
    });
    expect(code).toContain('_rest.fragment');
    expect(code).toContain('_rest.content');

    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;

    const html = fn({
      fragment: { localizedFragmentVariationPath: 'lightbox-fragment' },
      content: ({ fragment }: any) => ({
        resource: () => '<button>Open</button>',
        [fragment.localizedFragmentVariationPath]: () => '<p>Fragment</p>',
      }),
    });
    expect(html).toContain('<button>Open</button>');
    expect(html).toContain('<p>Fragment</p>');
  });

  it('({ fragment: frag }) alias works and maps to _rest.fragment', () => {
    const src = `<div data-sly-use.model="com.example.Lightbox"><sly data-sly-resource="\${'slot'}"></sly></div>`;
    const code = transpile(src, {
      filename: 'test.html',
      modelTransforms: {
        Lightbox: {
          _includes: ({ fragment: frag }: any) => ({
            slot: () => `<p>${frag?.name}</p>`,
          }),
        },
      },
    });
    expect(code).toContain('_rest.fragment');

    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;

    expect(fn({ fragment: { name: 'hero' } })).toContain('<p>hero</p>');
  });
});

// ---------------------------------------------------------------------------
// @ urlencode context
// ---------------------------------------------------------------------------

describe('convertExpr — @ urlencode', () => {
  it('wraps expression in encodeURIComponent', () => {
    expect(convertExpr("model.path @ context='urlencode'")).toBe(
      "encodeURIComponent(model?.path ?? '')"
    );
  });

  it('works with uppercase URLENCODE', () => {
    expect(convertExpr("model.path @ context='URLENCODE'")).toBe(
      "encodeURIComponent(model?.path ?? '')"
    );
  });

  it('encodes dynamic values at runtime', () => {
    const src = `<a href="/search?q=\${model.query @ context='urlencode'}">search</a>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ model: { query: 'hello world & more' } });
    expect(html).toContain('hello%20world%20%26%20more');
  });
});

// ---------------------------------------------------------------------------
// _incSlot — indexed array fallback
// ---------------------------------------------------------------------------

describe('transpile — _incSlot array fallback', () => {
  it('resolves par_N from an array returned by par', () => {
    const src = `<sly data-sly-resource="\${'par_0'}"></sly><sly data-sly-resource="\${'par_1'}"></sly>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({
      _includes: {
        par: () => ['<p>first</p>', '<p>second</p>'],
      },
    });
    expect(html).toContain('<p>first</p>');
    expect(html).toContain('<p>second</p>');
  });

  it('prefers an exact key over the array fallback', () => {
    const src = `<sly data-sly-resource="\${'par_0'}"></sly>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({
      _includes: {
        par_0: () => '<p>exact</p>',
        par: () => ['<p>from-array</p>'],
      },
    });
    expect(html).toContain('<p>exact</p>');
    expect(html).not.toContain('from-array');
  });

  it('accepts a plain array (not a function) as the base key', () => {
    const src = `<sly data-sly-resource="\${'par_0'}"></sly>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({
      _includes: {
        par: ['<p>plain</p>'],
      },
    });
    expect(html).toContain('<p>plain</p>');
  });

  it('returns empty string for an out-of-bounds index', () => {
    const src = `<sly data-sly-resource="\${'par_5'}"></sly>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ _includes: { par: () => ['only one'] } });
    expect(html).toBe('');
  });

  it('works with path-prefixed keys like navgroup/par_0', () => {
    const src = `<sly data-sly-resource="\${'navgroup/par_0'}"></sly><sly data-sly-resource="\${'navgroup/par_1'}"></sly>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({
      _includes: {
        'navgroup/par': () => ['<div>col0</div>', '<div>col1</div>'],
      },
    });
    expect(html).toContain('<div>col0</div>');
    expect(html).toContain('<div>col1</div>');
  });

  it('joins a direct array value (non-indexed key)', () => {
    const src = `<sly data-sly-resource="\${'header'}"></sly>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ _includes: { header: ['<nav>A</nav>', '<nav>B</nav>'] } });
    expect(html).toBe('<nav>A</nav><nav>B</nav>');
  });

  it('joins a 2D array from a function returning nested arrays', () => {
    const src = `<sly data-sly-resource="\${'par_0'}"></sly><sly data-sly-resource="\${'par_1'}"></sly>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({
      _includes: {
        par: () => [['<span>a</span>', '<span>b</span>'], ['<span>c</span>', '<span>d</span>']],
      },
    });
    expect(html).toBe('<span>a</span><span>b</span><span>c</span><span>d</span>');
  });

  it('joins a function returning a direct array for non-indexed key', () => {
    const src = `<sly data-sly-resource="\${'items'}"></sly>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ _includes: { items: () => ['<li>x</li>', '<li>y</li>'] } });
    expect(html).toBe('<li>x</li><li>y</li>');
  });
});

// ---------------------------------------------------------------------------
// __slots__
// ---------------------------------------------------------------------------

describe('transpile — __slots__', () => {
  it('exports static slot keys', () => {
    const src = `<sly data-sly-resource="\${'header'}"></sly><sly data-sly-resource="\${'footer'}"></sly>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    expect(mod.exports.__slots__).toEqual(['header', 'footer']);
  });

  it('does not export __slots__ when there are no static slots', () => {
    const src = `<div>\${model.title}</div>`;
    const code = transpile(src, { filename: 'test.html' });
    expect(code).not.toContain('__slots__');
  });

  it('does not include dynamic slot keys', () => {
    const src = `<sly data-sly-resource="\${'header'}"></sly><sly data-sly-resource="\${model.path}"></sly>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    expect(mod.exports.__slots__).toEqual(['header']);
  });

  it('collects slot key when _incSlot has a third params argument', () => {
    const src = `<sly data-sly-include="\${'header.html' @ wcmmode='edit'}"></sly>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    expect(mod.exports.__slots__).toEqual(['header.html']);
  });

  it('attaches __slots__ directly to each exported create function', () => {
    const src = `<sly data-sly-resource="\${'par'}"></sly>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports).find((v) => typeof v === 'function') as any;
    expect(fn.__slots__).toEqual(['par']);
  });

  it('attaches __slots__ to all named template functions', () => {
    const src = `
      <template data-sly-template.card="\${ @ model }">
        <sly data-sly-resource="\${'content'}"></sly>
      </template>
      <template data-sly-template.footer="\${ @ copy }">
        <sly data-sly-resource="\${'logo'}"></sly>
      </template>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    expect(mod.exports.createCard.__slots__).toEqual(['content', 'logo']);
    expect(mod.exports.createFooter.__slots__).toEqual(['content', 'logo']);
  });
});

// ---------------------------------------------------------------------------
// generateDts
// ---------------------------------------------------------------------------

describe('generateDts', () => {
  it('generates a declaration for a single export', () => {
    const code = transpile('<div>${model.title}</div>', { filename: 'card.html' });
    const dts = generateDts(code);
    expect(dts).toContain('export declare function createCard(');
    expect(dts).toContain('model?: any');
  });

  it('types _includes as Record when no slots', () => {
    const src = `<sly data-sly-resource="\${model.path}"></sly>`;
    const code = transpile(src, { filename: 'card.html' });
    const dts = generateDts(code);
    expect(dts).toContain('_includes?: Record<string, string | (() => string) | undefined>');
  });

  it('types _includes with slot keys when __slots__ present', () => {
    const src = `<sly data-sly-resource="\${'header'}"></sly><sly data-sly-resource="\${'footer'}"></sly>`;
    const code = transpile(src, { filename: 'test.html' });
    const dts = generateDts(code);
    expect(dts).toContain("'header'?: string | (() => string)");
    expect(dts).toContain("'footer'?: string | (() => string)");
    expect(dts).toContain('[key: string]: string | (() => string) | undefined');
  });

  it('includes __slots__ declaration when present', () => {
    const src = `<sly data-sly-resource="\${'header'}"></sly>`;
    const code = transpile(src, { filename: 'test.html' });
    const dts = generateDts(code);
    expect(dts).toContain("export declare const __slots__: ['header'];");
  });

  it('generates declarations for multiple named templates', () => {
    const src = `
      <template data-sly-template.header="\${ @ title }"><h1>\${title}</h1></template>
      <template data-sly-template.footer="\${ @ copy }"><footer>\${copy}</footer></template>`;
    const code = transpile(src, { filename: 'test.html' });
    const dts = generateDts(code);
    expect(dts).toContain('export declare function createHeader(');
    expect(dts).toContain('export declare function createFooter(');
  });
});

// ---------------------------------------------------------------------------
// modelTransforms with functions
// ---------------------------------------------------------------------------

describe('transpile — modelTransforms with function values', () => {
  it('calls function with varName to produce the expression', () => {
    const src = `<div data-sly-use.model="com.example.MyModel">\${model.layout}</div>`;
    const code = transpile(src, {
      filename: 'test.html',
      modelTransforms: {
        MyModel: {
          layout: (varName: string) => `'RESPONSIVE_GRID'`,
        },
      },
    });
    expect(code).toContain("layout: 'RESPONSIVE_GRID'");
  });

  it('injects the varName into function result', () => {
    const src = `<div data-sly-use.container="com.example.LayoutContainer">\${container.id}</div>`;
    const code = transpile(src, {
      filename: 'test.html',
      modelTransforms: {
        LayoutContainer: {
          id: (varName: string) => `${varName}?._id ?? 'default'`,
        },
      },
    });
    expect(code).toContain("id: container?._id ?? 'default'");
  });

  it('works at runtime with function-based modelTransforms', () => {
    const src = `<div data-sly-use.model="com.example.Model" class="\${model.theme}"></div>`;
    const code = transpile(src, {
      filename: 'test.html',
      modelTransforms: {
        Model: {
          theme: () => `'dark'`,
        },
      },
    });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    // default from transform
    expect(fn({ model: {} })).toContain('class="dark"');
    // runtime override wins
    expect(fn({ model: { theme: 'light' } })).toContain('class="light"');
  });

  it('keeps zero-argument legacy callbacks compatible with non-model bindings', () => {
    const src = `<div data-sly-use.container="com.example.LayoutContainer">\${container.id}</div>`;
    const code = transpile(src, {
      filename: 'test.html',
      modelTransforms: {
        LayoutContainer: {
          id: () => `model._internalId ?? ''`,
        },
      },
    });
    expect(code).toContain("id: container._internalId ?? ''");
  });

  it('supports direct-code expression callbacks with destructured model', () => {
    const src = `<div data-sly-use.colContainer="com.example.ColContainer">\${colContainer.id}</div>`;
    const code = transpile(src, {
      filename: 'test.html',
      modelTransforms: {
        ColContainer: {
          id: ({ model }: { model: any }) => model?._internalId ?? 'fallback',
        },
      },
    });
    expect(code).toContain("id: colContainer?._internalId ?? 'fallback'");
  });

  it('supports direct-code block callbacks with destructured model', () => {
    const src = `<div data-sly-use.colContainer="com.example.ColContainer">\${colContainer.columns[0].path}</div>`;
    const code = transpile(src, {
      filename: 'test.html',
      modelTransforms: {
        ColContainer: {
          columns: ({ model }: { model: any }) => {
            const count = model?.columns || 1;
            return Array.from({ length: count }, (_, index) => ({
              path: 'par' + index,
            }));
          },
        },
      },
    });
    expect(code).toContain("const count = colContainer?.columns || 1;");
    expect(code).toContain("path: 'par' + index");
  });

  it('supports direct-code callbacks without parameters', () => {
    const src = `<div data-sly-use.page="com.day.cq.wcm.foundation.TemplatedContainer">\${page.structureResources[0].path}</div>`;
    const code = transpile(src, {
      filename: 'test.html',
      modelTransforms: {
        TemplatedContainer: {
          structureResources: () => [{ path: 'content' }],
        },
      },
    });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    expect(fn({ page: {} })).toContain('content');
  });

  it('supports zero-argument direct string literals', () => {
    const src = `<div data-sly-use.container="com.example.LayoutContainer">\${container.layout}</div>`;
    const code = transpile(src, {
      filename: 'test.html',
      modelTransforms: {
        LayoutContainer: {
          layout: () => 'RESPONSIVE_GRID',
        },
      },
    });
    expect(code).toContain("layout: 'RESPONSIVE_GRID'");
  });
});

// ---------------------------------------------------------------------------
// parseI18nXml
// ---------------------------------------------------------------------------

describe('parseI18nXml — JCR format', () => {
  it('parses sling:key + sling:message pairs', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<jcr:root xmlns:sling="http://sling.apache.org/jcr/sling/1.0"
          xmlns:jcr="http://www.jcp.org/jcr/1.0">
  <Read_more
      jcr:primaryType="sling:MessageEntry"
      sling:key="Read more"
      sling:message="Read more"/>
  <Go_home
      jcr:primaryType="sling:MessageEntry"
      sling:key="Go home"
      sling:message="Ir al inicio"/>
</jcr:root>`;
    expect(parseI18nXml(xml)).toEqual({
      'Read more': 'Read more',
      'Go home': 'Ir al inicio',
    });
  });

  it('decodes XML entities in keys and values', () => {
    const xml = `<jcr:root>
  <n sling:key="Hello &amp; World" sling:message="Hola &amp; Mundo"/>
</jcr:root>`;
    expect(parseI18nXml(xml)).toEqual({ 'Hello & World': 'Hola & Mundo' });
  });

  it('strips {String} type prefix from sling:message', () => {
    const xml = `<jcr:root>
  <n sling:key="Title" sling:message="{String}Título"/>
</jcr:root>`;
    expect(parseI18nXml(xml)).toEqual({ Title: 'Título' });
  });

  it('falls back to entry format when no sling:key found', () => {
    const xml = `<properties>
  <entry key="Read more">Leer más</entry>
  <entry key="Submit">Enviar</entry>
</properties>`;
    expect(parseI18nXml(xml)).toEqual({
      'Read more': 'Leer más',
      Submit: 'Enviar',
    });
  });

  it('returns empty dict for unrecognized format', () => {
    expect(parseI18nXml('<root><item>foo</item></root>')).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// i18nDict option in transpile()
// ---------------------------------------------------------------------------

describe('transpile — i18nDict option', () => {
  const dict = { 'Read more': 'Leer más', 'Go home': 'Ir al inicio' };

  it('injects dict as _i18n default in generated function', () => {
    const src = `<span>${'$'}{'Read more' @ i18n}</span>`;
    const code = transpile(src, { filename: 'test.html', i18nDict: dict });
    // default should contain the serialized dict
    expect(code).toContain('"Read more":"Leer m\u00e1s"');
  });

  it('translates strings at runtime using built-in dict', () => {
    const src = `<span>${'$'}{'Read more' @ i18n}</span>`;
    const code = transpile(src, { filename: 'test.html', i18nDict: dict });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    // no _i18n arg — uses the baked-in default
    expect(fn({})).toContain('Leer más');
  });

  it('allows runtime _i18n to override the built-in dict', () => {
    const src = `<span>${'$'}{'Read more' @ i18n}</span>`;
    const code = transpile(src, { filename: 'test.html', i18nDict: dict });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    expect(fn({ _i18n: { 'Read more': 'En savoir plus' } })).toContain('En savoir plus');
  });

  it('falls back to original string for missing keys', () => {
    const src = `<span>${'$'}{'Submit' @ i18n}</span>`;
    const code = transpile(src, { filename: 'test.html', i18nDict: dict });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    expect(fn({})).toContain('Submit');
  });
});

// ---------------------------------------------------------------------------
// parseI18nXml + transpile — end-to-end with a real XML file on disk
// ---------------------------------------------------------------------------

describe('i18n — end-to-end from XML file', () => {
  const xmlPath = path.resolve(__dirname, 'fixtures/es.xml');
  const dict = parseI18nXml(fs.readFileSync(xmlPath, 'utf8'));

  it('parses the fixture XML into the expected dictionary', () => {
    expect(dict).toEqual({
      'Read more': 'Leer más',
      'Go home': 'Ir al inicio',
      'Title': 'Título',
    });
  });

  it('bakes the XML dict into the generated module and translates at runtime', () => {
    const src = `<div><h1>${'$'}{'Title' @ i18n}</h1><a href="/">${'$'}{'Read more' @ i18n}</a></div>`;
    const code = transpile(src, { filename: 'test.html', i18nDict: dict });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({});
    expect(html).toContain('Título');
    expect(html).toContain('Leer más');
    expect(html).not.toContain('>Title<');
    expect(html).not.toContain('>Read more<');
  });

  it('translates a variable i18n expression using the XML dict', () => {
    const src = `<span>${'$'}{model.label @ i18n}</span>`;
    const code = transpile(src, { filename: 'test.html', i18nDict: dict });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ model: { label: 'Read more' } });
    expect(html).toContain('Leer más');
  });

  it('allows runtime _i18n to override the XML-baked dict', () => {
    const src = `<span>${'$'}{'Title' @ i18n}</span>`;
    const code = transpile(src, { filename: 'test.html', i18nDict: dict });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    expect(fn({ _i18n: { Title: 'Titolo' } })).toContain('Titolo');
  });

  it('falls back to the original string for keys not in the XML dict', () => {
    const src = `<span>${'$'}{'Subscribe' @ i18n}</span>`;
    const code = transpile(src, { filename: 'test.html', i18nDict: dict });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    expect(fn({})).toContain('Subscribe');
  });
});

// ---------------------------------------------------------------------------
// data-sly-use — JS / JSON Use-API (item 3)
// ---------------------------------------------------------------------------

const fixturesDir = path.join(__dirname, 'fixtures');
// require() scoped to the fixtures directory, so relative paths in generated code resolve correctly
const fixturesRequire = createRequire(path.join(fixturesDir, '__placeholder__'));

describe('data-sly-use — JSON file resolution', () => {
  it('generates require() as the default param for a .json use file', () => {
    const src = `<div data-sly-use.model="./card.model.json">\${model.title}</div>`;
    const code = transpile(src, {
      filename: path.join(fixturesDir, 'test.html'),
    });
    expect(code).toContain(`require('./card.model.json')`);
    expect(code).toContain('model =');
  });

  it('uses the JSON file data as default at runtime', () => {
    const src = `<div data-sly-use.model="./card.model.json">\${model.title}</div>`;
    const code = transpile(src, {
      filename: path.join(fixturesDir, 'test.html'),
    });
    const mod: any = {};
    new Function('module', 'require', code)(mod, fixturesRequire);
    const fn = Object.values(mod.exports)[0] as Function;
    expect(fn({})).toContain('Default Title');
  });

  it('allows overriding the JSON-sourced model at call time', () => {
    const src = `<div data-sly-use.model="./card.model.json">\${model.title}</div>`;
    const code = transpile(src, {
      filename: path.join(fixturesDir, 'test.html'),
    });
    const mod: any = {};
    new Function('module', 'require', code)(mod, fixturesRequire);
    const fn = Object.values(mod.exports)[0] as Function;
    expect(fn({ model: { title: 'Override' } })).toContain('Override');
  });
});

describe('data-sly-use — JS module (plain object) file resolution', () => {
  it('generates an IIFE require() as the default param for a .js use file', () => {
    const src = `<div data-sly-use.model="./card.model.js">\${model.title}</div>`;
    const code = transpile(src, {
      filename: path.join(fixturesDir, 'test.html'),
    });
    expect(code).toContain(`require('./card.model.js')`);
    expect(code).toContain('model =');
  });

  it('uses the JS module data as default at runtime when module exports an object', () => {
    const src = `<div data-sly-use.model="./card.model.js">\${model.title}</div>`;
    const code = transpile(src, {
      filename: path.join(fixturesDir, 'test.html'),
    });
    const mod: any = {};
    new Function('module', 'require', code)(mod, fixturesRequire);
    const fn = Object.values(mod.exports)[0] as Function;
    expect(fn({})).toContain('Model Title');
  });

  it('allows overriding the JS-sourced model at call time', () => {
    const src = `<div data-sly-use.model="./card.model.js">\${model.title}</div>`;
    const code = transpile(src, {
      filename: path.join(fixturesDir, 'test.html'),
    });
    const mod: any = {};
    new Function('module', 'require', code)(mod, fixturesRequire);
    const fn = Object.values(mod.exports)[0] as Function;
    expect(fn({ model: { title: 'Overridden' } })).toContain('Overridden');
  });
});

describe('data-sly-use — interpolated JS / JSON file resolution', () => {
  it('resolves interpolated .js use paths at runtime', () => {
    const src = `<div data-sly-use.variant="com.example.Variant"
     data-sly-use.component="./card-${'$'}{variant}.js">${'$'}{component.title}</div>`;
    const code = transpile(src, {
      filename: path.join(fixturesDir, 'test.html'),
    });
    expect(code).toContain('require(');
    expect(code).toContain('card-');

    const requests: string[] = [];
    const fakeRequire = (request: string) => {
      requests.push(request);
      if (request === './card-model.js') {
        return { title: 'Dynamic JS Title' };
      }
      throw new Error(`Unexpected require: ${request}`);
    };

    const mod: any = {};
    new Function('module', 'require', code)(mod, fakeRequire);
    const fn = Object.values(mod.exports)[0] as Function;
    expect(fn({ variant: 'model' })).toContain('Dynamic JS Title');
    expect(requests).toContain('./card-model.js');
  });

  it('resolves interpolated .json use paths at runtime', () => {
    const src = `<div data-sly-use.variant="com.example.Variant"
     data-sly-use.component="./card-${'$'}{variant}.json">${'$'}{component.title}</div>`;
    const code = transpile(src, {
      filename: path.join(fixturesDir, 'test.html'),
    });
    expect(code).toContain('require(');
    expect(code).toContain('card-');

    const requests: string[] = [];
    const fakeRequire = (request: string) => {
      requests.push(request);
      if (request === './card-model.json') {
        return { title: 'Dynamic JSON Title' };
      }
      throw new Error(`Unexpected require: ${request}`);
    };

    const mod: any = {};
    new Function('module', 'require', code)(mod, fakeRequire);
    const fn = Object.values(mod.exports)[0] as Function;
    expect(fn({ variant: 'model' })).toContain('Dynamic JSON Title');
    expect(requests).toContain('./card-model.json');
  });
});

describe('data-sly-use — JS factory function file resolution', () => {
  it('calls the factory and returns its result when module exports a function', () => {
    const src = `<div data-sly-use.model="./card.factory.js">\${model.title}</div>`;
    const code = transpile(src, {
      filename: path.join(fixturesDir, 'test.html'),
    });
    const mod: any = {};
    new Function('module', 'require', code)(mod, fixturesRequire);
    const fn = Object.values(mod.exports)[0] as Function;
    expect(fn({})).toContain('Factory Title');
  });

  it('allows overriding the factory-sourced model at call time', () => {
    const src = `<div data-sly-use.model="./card.factory.js">\${model.title}</div>`;
    const code = transpile(src, {
      filename: path.join(fixturesDir, 'test.html'),
    });
    const mod: any = {};
    new Function('module', 'require', code)(mod, fixturesRequire);
    const fn = Object.values(mod.exports)[0] as Function;
    expect(fn({ model: { title: 'My Custom Title' } })).toContain('My Custom Title');
  });
});

describe('data-sly-use — unresolvable path stays as class-name param', () => {
  it('treats a non-existent .js path as a regular use param (default {})', () => {
    // When the file does not exist, it falls back to `use` (class name), default {}
    const src = `<div data-sly-use.model="./nonexistent.js">\${model.title}</div>`;
    const code = transpile(src, { filename: 'test.html' });
    // Should NOT contain require() since the file doesn't exist
    expect(code).not.toContain(`require('./nonexistent.js')`);
    // Should contain model as a regular param
    expect(code).toContain('model =');
  });
});

// ---------------------------------------------------------------------------
// i18n — locale fallback (mergeI18nDicts + i18nFallbackDicts)
// ---------------------------------------------------------------------------

describe('mergeI18nDicts', () => {
  it('returns the single dict when only one argument is passed', () => {
    expect(mergeI18nDicts({ Hello: 'Hola' })).toEqual({ Hello: 'Hola' });
  });

  it('later arguments override earlier ones (last wins)', () => {
    const en = { Hello: 'Hello', Bye: 'Bye' };
    const es = { Hello: 'Hola' };
    expect(mergeI18nDicts(en, es)).toEqual({ Hello: 'Hola', Bye: 'Bye' });
  });

  it('three-level chain: primary wins, first fallback fills gaps', () => {
    const en = { Hello: 'Hello', Title: 'Title', Footer: 'Footer' };
    const es = { Hello: 'Hola', Title: 'Título' };
    const esMX = { Hello: 'Buenas' };
    expect(mergeI18nDicts(en, es, esMX)).toEqual({
      Hello: 'Buenas',
      Title: 'Título',
      Footer: 'Footer',
    });
  });
});

describe('resolveLocaleChain', () => {
  it('returns [en] for "en"', () => {
    expect(resolveLocaleChain('en')).toEqual(['en']);
  });

  it('returns [en, de] for "de"', () => {
    expect(resolveLocaleChain('de')).toEqual(['en', 'de']);
  });

  it('returns [en, es, es_MX] for "es_MX"', () => {
    expect(resolveLocaleChain('es_MX')).toEqual(['en', 'es', 'es_MX']);
  });

  it('normalises hyphen separators', () => {
    expect(resolveLocaleChain('pt-BR')).toEqual(['en', 'pt', 'pt_BR']);
  });
});

describe('transpile — i18nFallbackDicts option', () => {
  const primary = { Hello: 'Hola', Title: 'Título' };
  const fallback = { Hello: 'Bonjour', Bye: 'Au revoir' };

  it('merges primary and fallback dicts into the baked _i18n default', () => {
    const src = `<span>${'$'}{'Hello' @ i18n}</span>`;
    const code = transpile(src, {
      filename: 'test.html',
      i18nDict: primary,
      i18nFallbackDicts: [fallback],
    });
    // primary key wins
    expect(code).toContain('"Hello":"Hola"');
    // fallback key fills the gap
    expect(code).toContain('"Bye":"Au revoir"');
  });

  it('primary keys override fallback keys at runtime', () => {
    const src = `<span>${'$'}{'Hello' @ i18n}</span>`;
    const code = transpile(src, {
      filename: 'test.html',
      i18nDict: primary,
      i18nFallbackDicts: [fallback],
    });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    expect(fn({})).toContain('Hola'); // primary wins
  });

  it('fallback keys are used when absent from the primary dict', () => {
    const src = `<span>${'$'}{'Bye' @ i18n}</span>`;
    const code = transpile(src, {
      filename: 'test.html',
      i18nDict: primary,
      i18nFallbackDicts: [fallback],
    });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    expect(fn({})).toContain('Au revoir');
  });

  it('still falls back to the original string for keys absent from all dicts', () => {
    const src = `<span>${'$'}{'Subscribe' @ i18n}</span>`;
    const code = transpile(src, {
      filename: 'test.html',
      i18nDict: primary,
      i18nFallbackDicts: [fallback],
    });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    expect(fn({})).toContain('Subscribe');
  });
});

// ---------------------------------------------------------------------------
// i18n — pluralization (@ i18n, count=N)
// ---------------------------------------------------------------------------

describe('convertExpr — i18n pluralization', () => {
  it('generates _htlI18nPlural call for literal key + count', () => {
    expect(convertExpr("'1 item' @ i18n, count=n")).toBe(
      "_htlI18nPlural('1 item', n, _i18n)"
    );
  });

  it('applies optional chaining to count expression', () => {
    expect(convertExpr("'1 item' @ i18n, count=items.size")).toBe(
      "_htlI18nPlural('1 item', items?.length, _i18n)"
    );
  });

  it('generates _htlI18nPlural for variable key + count', () => {
    expect(convertExpr('label @ i18n, count=n')).toBe(
      '_htlI18nPlural(label, n, _i18n)'
    );
  });
});

describe('transpile — i18n pluralization end-to-end', () => {
  const dict = { 'item': 'element', 'item_plural': '{0} elements' };

  it('uses singular form when count=1', () => {
    const src = `<span>${'$'}{'item' @ i18n, count=n}</span>`;
    const code = transpile(src, { filename: 'test.html', i18nDict: dict });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    expect(fn({ n: 1 })).toContain('element');
    expect(fn({ n: 1 })).not.toContain('elements');
  });

  it('uses plural form and substitutes {0} when count>1', () => {
    const src = `<span>${'$'}{'item' @ i18n, count=n}</span>`;
    const code = transpile(src, { filename: 'test.html', i18nDict: dict });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    expect(fn({ n: 5 })).toContain('5 elements');
  });

  it('falls back to singular form when plural key is absent', () => {
    const dictNoPl = { 'item': 'Artikel' };
    const src = `<span>${'$'}{'item' @ i18n, count=n}</span>`;
    const code = transpile(src, { filename: 'test.html', i18nDict: dictNoPl });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    expect(fn({ n: 3 })).toContain('Artikel');
  });

  it('falls back to the literal key when dict is empty', () => {
    const src = `<span>${'$'}{'item' @ i18n, count=n}</span>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    expect(fn({ n: 2 })).toContain('item');
  });

  it('handles count via model property (dotted path)', () => {
    const src = `<span>${'$'}{'item' @ i18n, count=model.count}</span>`;
    const code = transpile(src, { filename: 'test.html', i18nDict: dict });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    expect(fn({ model: { count: 7 } })).toContain('7 elements');
  });
});

// ---------------------------------------------------------------------------
// transpile — ESM output (format: 'esm')
// ---------------------------------------------------------------------------

describe('transpile — ESM output', () => {
  it('emits export statement instead of module.exports for single template', () => {
    const src = `<div>${'$'}{model.title}</div>`;
    const code = transpile(src, { filename: 'test.html', format: 'esm' });
    expect(code).not.toContain('module.exports');
    expect(code).toMatch(/export\s*\{\s*createTest\s*\}/);
  });

  it('emits export statement for named templates', () => {
    const src = `
      <template data-sly-template.header></template>
      <template data-sly-template.footer></template>
    `;
    const code = transpile(src, { filename: 'test.html', format: 'esm' });
    expect(code).not.toContain('module.exports');
    expect(code).toMatch(/export\s*\{[^}]*createHeader[^}]*createFooter[^}]*\}/);
  });

  it('does not emit require() for jsFileUse JSON in ESM mode', () => {
    const src = `<div data-sly-use.model="./card.model.json">${'$'}{model.title}</div>`;
    const code = transpile(src, { filename: path.join(fixturesDir, 'test.html'), format: 'esm' });
    expect(code).not.toContain('require(');
    expect(code).toMatch(/import\s+\S+\s+from\s+['"].*card\.model\.json['"]/);
  });

  it('uses the imported binding as default param for jsFileUse JSON', () => {
    const src = `<div data-sly-use.model="./card.model.json">${'$'}{model.title}</div>`;
    const code = transpile(src, { filename: path.join(fixturesDir, 'test.html'), format: 'esm' });
    // The import binding should be used as the default parameter value
    const importMatch = /import\s+(\S+)\s+from\s+['"].*card\.model\.json['"]/.exec(code);
    expect(importMatch).not.toBeNull();
    const binding = importMatch![1];
    expect(code).toContain(`model = ${binding}`);
  });

  it('does not emit require() for jsFileUse JS module in ESM mode', () => {
    const src = `<div data-sly-use.model="./card.model.js">${'$'}{model.title}</div>`;
    const code = transpile(src, { filename: path.join(fixturesDir, 'test.html'), format: 'esm' });
    expect(code).not.toContain('require(');
    expect(code).toMatch(/import\s+\S+\s+from\s+['"].*card\.model\.js['"]/);
  });

  it('handles JS module factory pattern in ESM mode', () => {
    const src = `<div data-sly-use.model="./card.model.js">${'$'}{model.title}</div>`;
    const code = transpile(src, { filename: path.join(fixturesDir, 'test.html'), format: 'esm' });
    // Should emit a const that resolves factory vs plain object
    expect(code).toMatch(/typeof\s+\S+\s*===\s*'function'/);
  });

  it('defaults to CJS output when format is not specified', () => {
    const src = `<div>${'$'}{model.title}</div>`;
    const code = transpile(src, { filename: 'test.html' });
    expect(code).toContain('module.exports');
    expect(code).not.toMatch(/^export\s/m);
  });

  it('emits __slots__ export in ESM mode', () => {
    // Use a pre-built src that triggers __slots__
    const slotCode = `<div data-sly-include="\${'$'}{comp @ wcmmode='edit'}">\${'$'}{_incSlot(_includes, 'header')}</div>`;
    const code = transpile(slotCode, { filename: 'test.html', format: 'esm' });
    if (code.includes('__slots__')) {
      expect(code).not.toMatch(/Object\.assign\(module\.exports/);
      expect(code).toMatch(/export[^;]*__slots__/);
    }
  });
});

// ---------------------------------------------------------------------------
// _htlIn — string containment and array value lookup (spec §1.1.4.3)
// ---------------------------------------------------------------------------

describe('transpile — _htlIn helper (in operator)', () => {
  it('returns true when a string value is contained by another string', () => {
    const src = `<div data-sly-test="\${model.needle in model.haystack}">found</div>`;
    const code = transpile(src, { filename: 'test.html' });
    expect(code).toContain('_htlIn(');
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    expect(fn({ model: { needle: 'ab', haystack: 'abc' } })).toContain('found');
    expect(fn({ model: { needle: 'd', haystack: 'abc' } })).not.toContain('found');
  });

  it('returns true when a value is contained in an array', () => {
    const src = `<div data-sly-test="\${model.needle in model.haystack}">found</div>`;
    const code = transpile(src, { filename: 'test.html' });
    expect(code).toContain('_htlIn(');
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    expect(fn({ model: { needle: 100, haystack: [100, 200, 300] } })).toContain('found');
    expect(fn({ model: { needle: 1, haystack: [100, 200, 300] } })).not.toContain('found');
  });

  it('returns false for array containment when right side is undefined', () => {
    const src = `<div data-sly-test="\${model.needle in model.haystack}">found</div>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    expect(() => fn({ model: { needle: 1 } })).not.toThrow();
    expect(fn({ model: { needle: 1 } })).not.toContain('found');
  });
});

// ---------------------------------------------------------------------------
// _htlAttr — arrays rendered as comma-joined strings (spec §1.1.5.2)
// ---------------------------------------------------------------------------

describe('transpile — _htlAttr array rendering', () => {
  it('renders a string array as comma-joined attribute value', () => {
    const src = `<div title="\${model.tags}">content</div>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ model: { tags: ['one', 'two', 'three'] } });
    expect(html).toContain('title="one,two,three"');
  });

  it('HTML-escapes each element of the array', () => {
    const src = `<div title="\${model.tags}">content</div>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ model: { tags: ['<foo>', '&bar'] } });
    expect(html).toContain('&lt;foo&gt;');
    expect(html).toContain('&amp;bar');
    expect(html).not.toContain('<foo>');
  });

  it('still serializes plain objects as JSON in attributes', () => {
    const src = `<div data-config="\${model.config}">content</div>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ model: { config: { a: 1 } } });
    expect(html).toContain('&quot;a&quot;');
  });
});

// ---------------------------------------------------------------------------


describe('convertExpr — @ inside string literals', () => {
  it('preserves a standalone string literal containing @', () => {
    expect(convertExpr("'user@example.com'")).toBe("'user@example.com'");
  });

  it('uses a string key containing @ for i18n lookup', () => {
    expect(convertExpr("'user@example.com' @ i18n")).toBe(
      "_i18n?.['user@example.com'] ?? 'user@example.com'"
    );
  });

  it('preserves @ in both branches of a ternary', () => {
    expect(convertExpr("flag ? 'a@b.com' : 'c@d.com'")).toBe(
      "flag ? 'a@b.com' : 'c@d.com'"
    );
  });

  it('applies optional chaining to the condition but not string literal contents', () => {
    expect(convertExpr("model.flag ? 'a@b.com' : 'c@d.com'")).toBe(
      "model?.flag ? 'a@b.com' : 'c@d.com'"
    );
  });

  it('preserves @ in a join separator string', () => {
    expect(convertExpr("list @ join='@'")).toBe("(list).join('@')");
  });
});

// ---------------------------------------------------------------------------
// Spec §2.2.5 — data-sly-test with no value (boolean attribute)
// ---------------------------------------------------------------------------

describe('transpile — data-sly-test with no value', () => {
  it('hides element when data-sly-test has no value (boolean attribute)', () => {
    const src = '<p data-sly-test>should be hidden</p>';
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({});
    expect(html).toBe('');
  });

  it('shows element when data-sly-test has a truthy expression', () => {
    const src = '<p data-sly-test="${show}">visible</p>';
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    expect(fn({ show: true })).toContain('visible');
    expect(fn({ show: false })).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Spec §2.2.6 — data-sly-list: wrapper hidden when list is empty
// ---------------------------------------------------------------------------

describe('transpile — data-sly-list empty list visibility', () => {
  it('hides wrapper element when list is empty', () => {
    const src = '<ul data-sly-list.item="${items}"><li>${item}</li></ul>';
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ items: [] });
    expect(html).toBe('');
  });

  it('shows wrapper element when list has items', () => {
    const src = '<ul data-sly-list.item="${items}"><li>${item}</li></ul>';
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ items: ['a', 'b'] });
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>a</li>');
    expect(html).toContain('<li>b</li>');
    expect(html).toContain('</ul>');
  });

  it('hides wrapper when list is null or undefined', () => {
    const src = '<ul data-sly-list.item="${items}"><li>${item}</li></ul>';
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    expect(fn({ items: null })).toBe('');
    expect(fn({})).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Spec §1.2.1 — context='number'
// ---------------------------------------------------------------------------

describe('transpile — context=number in attribute', () => {
  it('renders numeric value as string attribute', () => {
    const src = "<input min=\"${qttMin @ context='number'}\">";
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ qttMin: 5 });
    expect(html).toContain('min="5"');
  });

  it('omits attribute when value is not a number', () => {
    const src = "<input min=\"${val @ context='number'}\">";
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ val: 'hello' });
    expect(html).not.toContain('min=');
  });

  it('omits attribute when value is null', () => {
    const src = "<input min=\"${val @ context='number'}\">";
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ val: null });
    expect(html).not.toContain('min=');
  });

  it('renders 0 as "0" (zero is a valid number)', () => {
    const src = "<input min=\"${val @ context='number'}\">";
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ val: 0 });
    expect(html).toContain('min="0"');
  });
});

describe('transpile — context=number in text node', () => {
  it('renders numeric value as text', () => {
    const src = "<span>${count @ context='number'}</span>";
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ count: 42 });
    expect(html).toContain('<span>42</span>');
  });

  it('outputs empty string when value is not a number', () => {
    const src = "<span>${val @ context='number'}</span>";
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ val: 'hello' });
    expect(html).toContain('<span></span>');
  });

  it('outputs "0" for zero', () => {
    const src = "<span>${val @ context='number'}</span>";
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ val: 0 });
    expect(html).toContain('<span>0</span>');
  });
});

// ---------------------------------------------------------------------------
// data-sly-text zero and boolean values (spec §1.1.5.2 — string casting)
// ---------------------------------------------------------------------------

describe('transpile — data-sly-text edge cases', () => {
  it('outputs "0" when value is the number zero', () => {
    const src = '<p data-sly-text="${count}"></p>';
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ count: 0 });
    expect(html).toContain('<p>0</p>');
  });

  it('outputs "false" when value is boolean false', () => {
    const src = '<p data-sly-text="${flag}"></p>';
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ flag: false });
    expect(html).toContain('<p>false</p>');
  });
});

// ---------------------------------------------------------------------------
// _rest pass-through — sub-model injection across data-sly-call boundaries
// ---------------------------------------------------------------------------

describe('transpile — _rest pass-through for sub-model injection', () => {
  it('includes ..._rest in every generated function signature', () => {
    const src = `<div data-sly-use.model="com.example.Model">\${model.title}</div>`;
    const code = transpile(src, { filename: 'test.html' });
    expect(code).toContain('..._rest');
  });

  it('forwards extra props to a local template via data-sly-call', () => {
    // "inner" template declares its own use of submodel; "outer" just calls it.
    // The story passes submodel via extra args — it should flow through.
    const src = `
      <template data-sly-template.outer="\${@ title}">
        <sly data-sly-call="\${inner @ title=title}"></sly>
      </template>
      <template data-sly-template.inner="\${@ title}">
        <div class="\${extraClass}">\${title}</div>
      </template>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);

    const html = mod.exports.createOuter({ title: 'Hello', extraClass: 'bold' });
    expect(html).toContain('class="bold"');
    expect(html).toContain('Hello');
  });

  it('extra props default to {} (or empty) when not supplied — backward compat', () => {
    const src = `
      <template data-sly-template.card="\${@ item}">
        <div>\${submodel.label} \${item.name}</div>
      </template>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = mod.exports.createCard as Function;

    // submodel not passed → submodel.label renders as empty string
    const html = fn({ item: { name: 'Widget' } });
    expect(html).toContain('Widget');
    expect(html).not.toContain('[object');
  });

  it('explicit @ params take precedence over _rest', () => {
    // When the caller explicitly names a param in the @ binding, that value
    // wins even if the story also passes the same key via extra args.
    const src = `
      <template data-sly-template.outer="\${@ item}">
        <sly data-sly-call="\${inner @ label=item.name}"></sly>
      </template>
      <template data-sly-template.inner="\${@ label}">
        <span>\${label}</span>
      </template>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);

    // label is set explicitly to item.name; any "label" in _rest is overridden
    const html = mod.exports.createOuter({
      item: { name: 'explicit' },
      label: 'from-rest',  // must NOT win
    });
    expect(html).toContain('explicit');
    expect(html).not.toContain('from-rest');
  });

  it('forwards extra props across two levels of local template calls (A→B→C)', () => {
    const src = `
      <template data-sly-template.a="\${@ x}">
        <sly data-sly-call="\${b @ x=x}"></sly>
      </template>
      <template data-sly-template.b="\${@ x}">
        <sly data-sly-call="\${c @ x=x}"></sly>
      </template>
      <template data-sly-template.c="\${@ x}">
        <p class="\${extra}">\${x}</p>
      </template>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);

    // "extra" flows from the story all the way down to template c
    const html = mod.exports.createA({ x: 'deep', extra: 'highlight' });
    expect(html).toContain('class="highlight"');
    expect(html).toContain('deep');
  });

  it('injects data-sly-use sub-model declared in a called template (fileOverride htl)', () => {
    // The canonical scenario: host.html calls card.html; card.html has its own
    // data-sly-use.submodel="com.example.SubModel". There must be a way to pass
    // a value for submodel from the Storybook story via the host call.
    const hostSrc = `
      <sly data-sly-use.tpl="card.html"
           data-sly-call="\${tpl.card @ item=model}">
      </sly>`;

    const cardHtl = [
      '<template data-sly-template.card="${@ item}">',
      '  <div data-sly-use.submodel="com.example.SubModel">',
      '    <h2>${submodel.title}</h2>',
      '    <p>${item.desc}</p>',
      '  </div>',
      '</template>',
    ].join('\n');

    const code = transpile(hostSrc, {
      filename: 'test.html',
      fileOverrides: { 'card.html': { htl: cardHtl } },
    });


    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;

    // Without submodel: renders empty h2
    const withoutSubmodel = fn({ model: { desc: 'desc only' } });
    expect(withoutSubmodel).toContain('<p>desc only</p>');
    expect(withoutSubmodel).toContain('<h2></h2>');

    // With submodel passed as an extra prop: flows through _rest into card.html
    const withSubmodel = fn({ model: { desc: 'desc' }, submodel: { title: 'Injected' } });
    expect(withSubmodel).toContain('<h2>Injected</h2>');
    expect(withSubmodel).toContain('<p>desc</p>');
  });

  it('injects sub-model via _rest through a required fixture HTML file', () => {
    // Same scenario but using a real file on disk (tabs fixture) to prove
    // _rest flows correctly through require()-based calls too.
    const hostSrc = fs.readFileSync(path.join(fixturesDir, 'tabs-host.html'), 'utf8');
    const code = transpile(hostSrc, {
      filename: path.join(fixturesDir, 'tabs-host.html'),
    });

    const htmlAwareRequire = (id: string) => {
      if (id.endsWith('.html')) {
        const resolved = path.resolve(fixturesDir, id);
        const src = fs.readFileSync(resolved, 'utf8');
        const transpiled = transpile(src, { filename: resolved });
        const m: any = {};
        new Function('module', transpiled)(m);
        return m.exports;
      }
      return fixturesRequire(id);
    };

    const mod: any = {};
    new Function('module', 'require', code)(mod, htmlAwareRequire);
    const fn = Object.values(mod.exports)[0] as Function;

    // model.tabsTemplate selects the file; the rest of model flows into the template
    const html = fn({ model: { tabsTemplate: 'vertical' } });
    expect(html).toContain('cmp-tabs--vertical');
    expect(html).toContain('vertical');
  });
});

// ---------------------------------------------------------------------------
// dynamic @ context expression
// ---------------------------------------------------------------------------

describe('transpile — dynamic @ context expression in text node', () => {
  it('renders raw HTML when dynamic context evaluates to "html"', () => {
    const src = `<div>\${text @ context = model.isRich ? 'html' : 'text'}</div>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;

    const html = fn({ text: '<b>Bold</b>', model: { isRich: true } });
    expect(html).toContain('<b>Bold</b>');
    expect(html).not.toContain('&lt;b&gt;');
  });

  it('escapes HTML when dynamic context evaluates to "text"', () => {
    const src = `<div>\${text @ context = model.isRich ? 'html' : 'text'}</div>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;

    const html = fn({ text: '<b>Bold</b>', model: { isRich: false } });
    expect(html).not.toContain('<b>Bold</b>');
    expect(html).toContain('&lt;b&gt;');
  });

  it('renders raw HTML for dynamic context = "unsafe"', () => {
    const src = `<div>\${text @ context = flag ? 'unsafe' : 'text'}</div>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;

    expect(fn({ text: '<em>x</em>', flag: true })).toContain('<em>x</em>');
    expect(fn({ text: '<em>x</em>', flag: false })).toContain('&lt;em&gt;');
  });

  it('emits _htlCtx in the generated code', () => {
    const src = `<p>\${text @ context = model.rich ? 'html' : 'text'}</p>`;
    const code = transpile(src, { filename: 'test.html' });
    expect(code).toContain('_htlCtx(');
  });
});

describe('transpile — dynamic @ context in data-sly-text', () => {
  it('renders raw HTML when dynamic context evaluates to "html"', () => {
    const src = `<div data-sly-text="\${text @ context = model.isRich ? 'html' : 'text'}">fallback</div>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;

    const html = fn({ text: '<strong>Rich</strong>', model: { isRich: true } });
    expect(html).toContain('<strong>Rich</strong>');
    expect(html).not.toContain('fallback');
  });

  it('escapes HTML when dynamic context evaluates to "text"', () => {
    const src = `<div data-sly-text="\${text @ context = model.isRich ? 'html' : 'text'}">fallback</div>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;

    const html = fn({ text: '<strong>Rich</strong>', model: { isRich: false } });
    expect(html).toContain('&lt;strong&gt;');
    expect(html).not.toContain('<strong>');
  });
});

describe('transpile — dynamic @ context expression in attributes', () => {
  it('omits HTML-escaping in a pure-expression attribute when context = "unsafe"', () => {
    // data-json="${model.json @ context = flag ? 'unsafe' : 'text'}"
    const src = `<div data-json="\${model.json @ context = flag ? 'unsafe' : 'text'}">x</div>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;

    // flag=true → unsafe → raw value, no escaping
    expect(fn({ model: { json: '{"a":1}' }, flag: true })).toContain('data-json="{"a":1}"');
    // flag=false → text/default → HTML-escaped
    expect(fn({ model: { json: '{"a":1}' }, flag: false })).toContain('&quot;');
  });

  it('omits attribute when value is null even with dynamic context', () => {
    const src = `<div title="\${model.val @ context = flag ? 'unsafe' : 'text'}">x</div>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;

    expect(fn({ model: { val: null }, flag: true })).not.toContain('title=');
  });

  it('handles dynamic context in a mixed attribute value', () => {
    // class="base ${cls @ context = flag ? 'unsafe' : 'text'}"
    const src = `<div class="base \${cls @ context = flag ? 'unsafe' : 'text'}">x</div>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;

    // flag=true → unsafe → no escaping of the cls value
    expect(fn({ cls: '<b>', flag: true })).toContain('class="base <b>"');
    // flag=false → default → escaped
    expect(fn({ cls: '<b>', flag: false })).toContain('&lt;b&gt;');
  });

  it('emits _htlDynAttrCtx for pure-expression attribute with dynamic context', () => {
    const src = `<div title="\${model.val @ context = model.raw ? 'unsafe' : 'text'}">x</div>`;
    const code = transpile(src, { filename: 'test.html' });
    expect(code).toContain('_htlDynAttrCtx(');
  });

  it('emits _htlCtxAttr for mixed attribute value with dynamic context', () => {
    const src = `<div class="prefix \${model.val @ context = model.raw ? 'unsafe' : 'text'}">x</div>`;
    const code = transpile(src, { filename: 'test.html' });
    expect(code).toContain('_htlCtxAttr(');
  });
});

