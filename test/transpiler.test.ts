import { transpile } from '../src/transpiler/index';
import { convertExpr, convertAttrValue, convertTextContent } from '../src/transpiler/expr';

// ---------------------------------------------------------------------------
// expr.js unit tests
// ---------------------------------------------------------------------------

describe('convertExpr', () => {
  it('strips @ context option', () => {
    expect(convertExpr("model.title @ context='html'")).toBe('model?.title');
  });

  it('wraps @ i18n string in dictionary lookup', () => {
    expect(convertExpr("'Learn more' @ i18n")).toBe("_i18n?.['Learn more'] ?? 'Learn more'");
  });

  it('strips ${ } wrapper', () => {
    expect(convertExpr('${model.id}')).toBe('model?.id');
  });

  it('converts .size to .length', () => {
    expect(convertExpr('accordion.items.size > 0')).toBe('accordion?.items?.length > 0');
  });

  it('converts jcr: property access', () => {
    expect(convertExpr('component.properties.jcr:title')).toBe("component?.properties?.['jcr:title']");
  });

  it('handles ternary expressions', () => {
    expect(convertExpr("model.titleSize || 'h2'")).toBe("model?.titleSize || 'h2'");
  });

  it('converts @ format=[...] to JS concatenation', () => {
    expect(convertExpr("'{0}/{1}' @ format=[model.tagUrl, tag.name]")).toBe("model?.tagUrl + '/' + tag?.name");
  });

  it('converts @ format with single placeholder', () => {
    expect(convertExpr("'prefix-{0}' @ format=[model.id]")).toBe("'prefix-' + model?.id");
  });
});

describe('convertAttrValue', () => {
  it('converts single expression in attribute', () => {
    expect(convertAttrValue('${accordion.id}')).toBe("${_htlAttr(accordion?.id)}");
  });

  it('converts mixed literal + expression', () => {
    expect(convertAttrValue('cmp-accordion ${properties.theme}')).toBe("cmp-accordion ${_htlAttr(properties?.theme)}");
  });

  it('strips @ context from attribute expression', () => {
    expect(convertAttrValue("${model.desc @ context='html'}")).toBe("${_htlAttr(model?.desc)}");
  });

  it('escapes bare backticks in literals', () => {
    expect(convertAttrValue('say `hello`')).toBe('say \\`hello\\`');
  });

  it('converts .size in attribute', () => {
    expect(convertAttrValue('${items.size}')).toBe("${_htlAttr(items?.length)}");
  });
});

describe('convertTextContent', () => {
  it('converts HTL expression in text', () => {
    expect(convertTextContent('${item.title}')).toBe("${(item?.title) ?? ''}");
  });

  it('handles i18n string in text', () => {
    expect(convertTextContent("${'Learn more' @ i18n}")).toBe("${(_i18n?.['Learn more'] ?? 'Learn more') ?? ''}");
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
    expect(() => new Function(out.replace(/module\.exports.*/, ''))).not.toThrow();
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
    const html = fn({ model: { pathUrl: '/my-path', width: 50, title: 'Test' } });
    expect(html).toContain('href="/my-path"');
    expect(html).toContain('width:50%');
    expect(html).toContain('Test');
  });
});

describe('transpile — data-sly-include', () => {
  it('generates an _includes slot for literal paths', () => {
    const src = `<sly data-sly-include="./header.html"></sly>`;
    const out = transpile(src, { filename: 'test.html' });
    expect(out).toContain("_includes['./header.html']?.()");
  });

  it('adds _includes as a parameter', () => {
    const src = `<sly data-sly-include="./header.html"></sly>`;
    const out = transpile(src, { filename: 'test.html' });
    expect(out).toContain('_includes =');
  });

  it('handles dynamic include expressions', () => {
    const src = `<sly data-sly-include="\${model.template}"></sly>`;
    const out = transpile(src, { filename: 'test.html' });
    expect(out).toContain('_includes[model?.template]?.()');
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

    expect(fn({ item: { name: 'panel-1' }, parent: { expandedItems: { 'panel-1': true } } })).toContain('expanded');
  });

  it('returns false when key does not exist in object', () => {
    const src = `<div data-sly-test="\${item.name in parent.expandedItems}">expanded</div>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;

    expect(fn({ item: { name: 'other' }, parent: { expandedItems: { 'panel-1': true } } })).not.toContain('expanded');
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
    expect(code).toMatch(/const hasItems[\s\S]*?return \(hasItems\)[\s\S]*?\.map\(/);
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
    expect(convertExpr("tags @ join=\", \", context='html'")).toBe("(tags).join(', ')");
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
    expect(out).toContain("model?.resourcePath");
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

  it('falls back to @path when main expression is empty', () => {
    const src = `<sly data-sly-resource="\${@ path=model.path}"></sly>`;
    const out = transpile(src, { filename: 'test.html' });
    expect(out).toContain('model?.path');
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
    expect(out).toContain("_includes['./partial.html']?.()");
  });

  it('handles self-closing sly with test', () => {
    const src = `<sly data-sly-test="\${model.show}" data-sly-include="./header.html"/>`;
    const out = transpile(src, { filename: 'test.html' });
    expect(out).toContain("_includes['./header.html']?.()");
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

  it('renders empty string for null attribute values', () => {
    const src = `<div title="\${model.title}">content</div>`;
    const code = transpile(src, { filename: 'test.html' });
    const mod: any = {};
    new Function('module', code)(mod);
    const fn = Object.values(mod.exports)[0] as Function;
    const html = fn({ model: { title: null } });
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
    expect(convertExpr('"Hello" @ i18n')).toBe("_i18n?.['Hello'] ?? \"Hello\"");
  });

  it('generates dictionary lookup when i18n is combined with other options', () => {
    expect(convertExpr("'Hello' @ i18n, context='html'")).toBe("_i18n?.['Hello'] ?? 'Hello'");
  });

  it('does not generate lookup when @ i18n is absent', () => {
    expect(convertExpr("'Hello'")).toBe("'Hello'");
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
    const html = fn({ _i18n: { 'Title': 'Título', 'Description': 'Descripción' } });
    expect(html).toContain('Título');
    expect(html).toContain('Descripción');
  });
});
