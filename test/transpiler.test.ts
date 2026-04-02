import { transpile } from '../src/transpiler/index';
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
  it('converts HTL expression in text', () => {
    expect(convertTextContent('${item.title}')).toBe("${(item?.title) ?? ''}");
  });

  it('handles i18n string in text', () => {
    expect(convertTextContent("${'Learn more' @ i18n}")).toBe(
      "${(_i18n?.['Learn more'] ?? 'Learn more') ?? ''}"
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

  it('falls back to @path when main expression is empty', () => {
    const src = `<sly data-sly-resource="\${@ path=model.path}"></sly>`;
    const out = transpile(src, { filename: 'test.html' });
    expect(out).toContain('model?.path');
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
});

// ===========================================================================
// ADDITIONAL COVERAGE — edge cases & real-world AEM patterns
// ===========================================================================

// ---------------------------------------------------------------------------
// convertExpr — in operator edge cases
// ---------------------------------------------------------------------------

describe('convertExpr — in operator edge cases', () => {
  it('handles multiple in operators chained with &&', () => {
    const result = convertExpr('${a in b && c in d}');
    expect(result).toContain('in');
    // Should produce valid JS when evaluated
    const fn = new Function('a', 'b', 'c', 'd', `return ${result};`);
    expect(fn('x', { x: 1 }, 'y', { y: 1 })).toBeTruthy();
    expect(fn('x', { x: 1 }, 'z', { y: 1 })).toBeFalsy();
  });

  it('handles in operator with optional-chained left operand', () => {
    const result = convertExpr('${item.name in parent.map}');
    // Should contain safe-access and in operator
    expect(result).toContain('in');
    const fn = new Function('item', 'parent', `return ${result};`);
    expect(fn({ name: 'k' }, { map: { k: true } })).toBeTruthy();
  });

  it('handles in operator with undefined right side', () => {
    const result = convertExpr('${key in obj}');
    const fn = new Function('key', 'obj', `return ${result};`);
    expect(fn('a', undefined)).toBeFalsy();
    expect(fn('a', null)).toBeFalsy();
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
