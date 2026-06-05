# htl-to-js

[![npm version](https://img.shields.io/npm/v/htl-to-js.svg)](https://www.npmjs.com/package/htl-to-js)
[![license](https://img.shields.io/npm/l/htl-to-js.svg)](./LICENSE)

Webpack loader and CLI that transpiles AEM HTL (Sightly) templates into JavaScript functions returning template literals.

Each generated `createXxx` function returns an object that behaves as a string (via `toString()` / template literal coercion) and also carries component metadata:

```js
{
  toString: () => html,       // the rendered HTML string
  _class: 'image',            // CSS class derived from the component path
  _resourceType: 'mysite/components/image', // full resource type from jcr_root
  _slots: ['header', 'footer'], // static slot keys (same as __slots__)
  _decorationTagName: undefined,
  _attrs: {},
}
```

This metadata is used internally by `_wrapResource` to auto-derive decoration classes when components are nested — it propagates through wrapper chains transparently.

```js
import { createAccordion } from '../../jcr_root/apps/mysite/components/accordion/accordion.html';
```

---

## Installation

```bash
npm install --save-dev htl-to-js
```

Requires Node.js >= 18.

---

## Storybook setup (webpack5)

Add the loader rule in `.storybook/main.js`. Since Storybook config files are often ESM, use `createRequire` to resolve the loader path:

```js
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const config = {
  // ...
  async webpackFinal(config) {
    config.module.rules.push({
      test: /\.html$/,
      include: /jcr_root[\\/]apps/,   // only AEM component HTML
      use: require.resolve('htl-to-js/loader'),
    });
    return config;
  }
};

export default config;
```

If your Storybook config uses CommonJS:

```js
module.exports = {
  async webpackFinal(config) {
    config.module.rules.push({
      test: /\.html$/,
      include: /jcr_root[\\/]apps/,
      use: require.resolve('htl-to-js/loader'),
    });
    return config;
  }
};
```

### Storybook preview setup

Since `createXxx` functions return an enriched object (not a plain string), add a global decorator in `.storybook/preview.js` to coerce the result before Storybook validates it:

```js
export const decorators = [
  (storyFn, context) => {
    const result = storyFn(context);
    return result != null && typeof result === 'object' && '_class' in result
      ? result.toString()
      : result;
  },
];
```

Without this, Storybook throws _"Did you forget to return the HTML snippet from the story?"_ even when the render function returns a valid enriched component result. The decorator lets stories stay as `render: (args) => createComponent(args)` without any extra wrapping.

---

## HTL directive support

| Directive | Behavior |
|---|---|
| `data-sly-use.name="..."` | Becomes a function parameter |
| `data-sly-use.name="tpl-${expr}.html"` | Interpolated path — `require(\`./tpl-${expr}.html\`)` so Webpack can statically analyze and bundle all matching files |
| `data-sly-test="${cond}"` | Conditional rendering via ternary |
| `data-sly-test` (no value) | Always hides the element (equivalent to `data-sly-test="${false}"`) |
| `data-sly-test.varName="${cond}"` | Conditional + assigns result to variable |
| `data-sly-repeat.item="${list}"` | Loop: repeats the **whole element** per item |
| `data-sly-list.item="${list}"` | Loop: outer tag rendered once, **inner content** repeated |
| `data-sly-element="${expr}"` | Dynamic tag name (falls back to original tag) |
| `data-sly-unwrap` / `data-sly-unwrap="${cond}"` | Strips wrapper tag (always or conditionally) |
| `data-sly-set.varName="${expr}"` | Local variable declaration |
| `data-sly-text="${expr}"` | Replaces element inner content with expression |
| `data-sly-attribute.name="${expr}"` | Dynamic named attribute (null omits, true → valueless) |
| `data-sly-attribute="${obj}"` | Object spread as multiple attributes |
| `data-sly-template.name="${ @ params }"` | Named export function |
| `data-sly-call="${tmpl @ p=v}"` | Invokes a template function |
| `data-sly-resource="${expr}"` | Slot via `_includes` map |
| `data-sly-include="./file.html"` | Delegates to `_includes` map |
| `<sly>` | Transparent wrapper — only children are rendered |

Both `data-sly-repeat` and `data-sly-list` support bare forms (without `.varName`) that default to `item` as the iteration variable. They also provide a `${itemList}` status object with `index`, `count`, `first`, `last`, `middle`, `odd`, and `even` properties.

### Expression conversions

| HTL | Generated JS |
|---|---|
| `${expr @ context='html'}` | `${expr}` (context options stripped) |
| `${expr @ context='urlencode'}` | `${encodeURIComponent(expr ?? '')}` (URL-encodes the value) |
| `${expr @ context='uri'}` on any attribute | `${_htlUri(expr ?? '')}` (URI-encodes the value) |
| `${expr @ context='number'}` | `${_htlNum(expr) ?? ''}` — converts to a numeric string; `null`/booleans/arrays/`NaN` produce an empty string |
| `${'string' @ i18n}` | `${_i18n?.['string'] ?? 'string'}` (dictionary lookup) |
| `${list.size}` | `${list.length}` |
| `${obj.jcr:title}` | `${obj?.['jcr:title']}` |
| `${tags @ join=', '}` | `${(tags).join(', ')}` |
| `${'pattern {0}/{1}' @ format=[a, b]}` | `${a + '/' + b}` |
| `${key in obj}` | `${_htlIn(key, obj)}` — string containment, array `.includes()`, or object key check |

### Auto-URI context

When a dynamic expression appears in an attribute whose name is a URI attribute (`href`, `src`, `action`, `formaction`, `cite`, `data`, `manifest`, `poster`), the `uri` display context is applied automatically even without an explicit `@ context='uri'`:

```html
<!-- Both of these produce the same generated code -->
<a href="${model.url}">link</a>
<a href="${model.url @ context='uri'}">link</a>
```

Generated:

```js
href="${_htlDynAttr('href', _htlUri(model?.url ?? ''))}"
```

### HTML escaping

Attribute values are automatically escaped via the `_htlAttr` helper:
- `&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`, `"` → `&quot;`
- Array values are rendered as comma-joined strings: `['a','b']` → `a,b`
- Plain object values are serialized with `JSON.stringify`
- `null`/`undefined` produce an empty string

Dynamic named attributes (`data-sly-attribute.name`) use `_htlDynAttr`:
- `null`/`false` → attribute omitted entirely
- `true` → valueless boolean attribute (e.g. `disabled`)
- Other values → `name="escaped-value"`

### AEM implicit objects

The following AEM implicit objects are automatically detected and added as optional parameters with safe defaults:

| Object | Default |
|---|---|
| `wcmmode` | `{ edit: false, disabled: true, preview: false }` |
| `properties` | `{}` |
| `pageProperties` | `{}` |
| `inheritedPageProperties` | `{}` |
| `component` | `{}` |
| `currentDesign` | `{}` |
| `currentStyle` | `{}` |
| `currentPage` | `{}` |
| `resource` | `{}` |
| `model` | `{}` |
| `_includes` | `{}` |
| `_i18n` | `{}` |
| `_wrapperClass` | `''` |
| `_resourceWrappers` | `{}` |
| `_resourceDecorations` | `{}` |
| `request` | `{ requestPathInfo: { selectorString: '', suffix: '', resourcePath: '' }, contextPath: '' }` |

Variables declared via `data-sly-use.X` are always included as parameters. Any other free variables referenced in directive expressions are also detected and added as parameters with `{}` defaults.

### Automatic attribute stripping

The following AEM author-mode and analytics attributes are stripped by default:

- `data-cmp-data-layer` — analytics data layer JSON
- `data-placeholder-text` — author mode placeholder
- `data-panelcontainer` — author mode panel container
- `data-component-name` — AEM component tracking
- `data-region-id` — analytics region tracking
- `data-emptytext` — author mode empty text

> **Note:** `data-cmp-hook-*` attributes are **not** stripped by default because the AEM Core Components site JS uses them at runtime.

### Other features

- **Void elements** (`<br>`, `<img>`, `<input>`, etc.) are rendered as self-closing tags
- **HTL block comments** (`<!--/* ... */-->`) are stripped from output
- **Regular HTML comments** (`<!-- ... -->`) are preserved
- **Self-closing `<sly/>`** is expanded automatically
- **camelCase variable names** are preserved through parse5's lowercasing
- **Reserved words** (`class`, `for`) are escaped to `_class`, `_for` in generated JS

---

## Generated output

Given `accordion.html`:

```html
<div data-sly-use.accordion="com.example.Accordion"
     class="cmp-accordion ${properties.theme}"
     id="${accordion.id}">
  <div data-sly-repeat.item="${accordion.items}"
       data-sly-test="${accordion.items.size > 0}">
    <span>${item.title}</span>
  </div>
</div>
```

The loader generates:

```js
// AUTO-GENERATED from accordion.html — DO NOT EDIT

const _htlAttr = (v) => v == null ? '' : (typeof v === 'object' ? JSON.stringify(v).replace(/"/g, '&quot;') : String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'));
const _htlDynAttr = (name, val) => { ... };
const _htlSpreadAttrs = (obj) => { ... };

const createAccordion = ({ accordion = {}, properties = {} } = {}) => {
  const _html = /* html */`<div class="cmp-accordion ${_htlAttr(properties?.theme)}" id="${_htlAttr(accordion?.id)}">...</div>`;
  return { toString: () => _html, _class: 'accordion', _resourceType: null, _slots: undefined, _decorationTagName: undefined, _attrs: {} };
};
module.exports = { createAccordion };
```

### Named templates (`data-sly-template`)

Files that define named templates generate one export per template:

```html
<!-- template/default.html -->
<template data-sly-template.default="${ @ model }">
  <a class="template" href="${model.url}">
    <h3>${model.title}</h3>
  </a>
</template>
```

Generates:

```js
const createDefault = ({ model = {} } = {}) => {
  const _html = /* html */`<a class="template" href="${_htlAttr(model?.url)}">
    <h3>${(model?.title) ?? ''}</h3>
  </a>`;
  return { toString: () => _html, _class: 'default', _resourceType: null, _slots: undefined, _decorationTagName: undefined, _attrs: {} };
};
module.exports = { createDefault };
```

---

## `data-sly-resource` (slots)

`data-sly-resource` loads a child JCR node at runtime in AEM — there is no equivalent in Storybook. The loader converts it to an `_includes` slot:

```html
<!-- HTL -->
<sly data-sly-resource="${'header'}"></sly>

<!-- With @path fallback -->
<sly data-sly-resource="${@ path=model.path}"></sly>

<!-- appendPath / prependPath -->
<sly data-sly-resource="${'my/path' @ appendPath='child'}"></sly>
<sly data-sly-resource="${'my/path' @ prependPath='root'}"></sly>
```

```js
// Generated
${_wrapResource('header', _includes, undefined, Object.assign({}, _staticResourceWrappers ?? {}, _resourceWrappers), undefined, undefined, undefined, undefined, Object.assign({}, _staticResourceDecorations ?? {}, _resourceDecorations))}
${_wrapResource(model?.path, _includes, undefined, ...)}
// appendPath/prependPath resolved at compile time when static
${_wrapResource('my/path/child', _includes, undefined, ...)}
${_wrapResource('root/my/path', _includes, undefined, ...)}
```

Pass content via `_includes` in your story args. Each slot value can be a string, function, array, or enriched component result — they all resolve to HTML:

| slot value | result |
|---|---|
| `'string'` | rendered as-is |
| `createXxx()` | rendered via `toString()` |
| `() => 'string'` | function called, result rendered |
| `() => createXxx()` | function called, enriched object rendered via `toString()` |
| `['a', 'b']` | items joined: `'ab'` |
| `[createText(), createImage()]` | each item rendered via `toString()`, joined |
| `() => ['a', 'b']` | function called, array joined |

```js
export const Default = {
  args: {
    _includes: {
      header: '<nav>Navigation</nav>',            // plain string
      sidebar: () => createSidebar({ title: 'Menu' }),    // function
      tags: ['<li>One</li>', '<li>Two</li>'],     // array — joined automatically
      items: () => [createCard({ id: 1 }), createCard({ id: 2 })],  // function returning array
    }
  }
}
```

#### Function parameters in `_includes` slots

When an `_includes` slot value is a function, it is called with the `data-sly-resource @options` from the HTL template — typically `{}` unless the HTL explicitly passes options:

```html
<!-- HTL: no options → slot function called with {} -->
<sly data-sly-resource="${'sidebar'}"></sly>

<!-- HTL: options → slot function called with { wcmmode: 'edit' } -->
<sly data-sly-resource="${'sidebar' @ wcmmode='edit'}"></sly>
```

```js
// The slot function receives only the @options — NOT the parent component's model
args: {
  _includes: {
    sidebar: (slotParams) => createSidebar({ title: 'Static title' }),
    //        ^^^^^^^^^^  usually {} — does not include parent model
  }
}
```

If you need parent component data inside a slot function, use a closure in the story or use the [`content` shorthand](#content-shorthand) instead, which receives all parent props.

```js
// Closure workaround for _includes when you need parent data
const parentModel = { title: 'My Title' };
createContainer({
  model: parentModel,
  _includes: {
    header: () => createHeader({ title: parentModel.title }),  // close over parent data
  },
});
```

#### Indexed slots (`par_N`)

When a template has indexed slots (`par_0`, `par_1`, …), supply a single array under the base key. Each index resolves to the corresponding array element — 2D arrays are supported so inner items concatenate within each slot:

```js
args: {
  _includes: {
    // Instead of:
    //   par_0: '<div>First</div>',
    //   par_1: '<div>Second</div>',
    // You can write:
    par: ['<div>First</div>', '<div>Second</div>'],
    // or with a factory:
    par: () => [createText(), createImage()],
    // 2D: inner array items concatenate within each slot
    par: () => [
      [createText(), createImage()],  // → par_0
      [createCard()],                  // → par_1
    ],
  }
}
```

An exact match for `par_0` always takes priority over the array fallback.

### `__slots__`

When a template uses static `data-sly-resource` keys (string literals), the generated module exports a `__slots__` array listing those keys. It is also attached directly to every exported `create*` function, so you can inspect it at the call site without a separate import:

```js
import { createHeader, __slots__ } from '../header/header.template.js';
// __slots__ === ['hero', 'footer']

// Also available on the function itself:
createHeader.__slots__; // ['hero', 'footer']
```

Dynamic keys (expressions like `${model.path}`) are not included — only compile-time string literals appear in `__slots__`.

### Decoration tags

In AEM, components rendered via `data-sly-resource` are usually wrapped in a decoration `<div>` with a CSS class derived from the component's resource type. HTL-to-js reproduces this with the `decorationTagName` and `cssClassName` options on `data-sly-resource`, plus automatic class derivation.

```html
<!-- HTL: explicit decoration tag and CSS class -->
<sly data-sly-resource="${'item' @ decorationTagName='div', cssClassName='my-class'}"></sly>

<!-- HTL: decoration tag with automatic class from resourceType -->
<sly data-sly-resource="${'item' @ decorationTagName='div', resourceType='mysite/components/image'}"></sly>
```

When `decorationTagName` is set and the slot function's return value carries a `_class` property (which all transpiled `createXxx` functions provide), the decoration class is derived automatically in this order:

1. **`resourceType` last segment** — e.g. `resourceType='mysite/components/image'` → class `image`
2. **`_class` on the return value** — when the slot is a wrapper chain like `() => createContainer({...})`, the `_class: 'container'` from `createContainer`'s return value propagates up automatically
3. **`fn.name`** — if the slot function is named `createImage`, the class `image` is derived from the function name
4. **`cssClassName`** — appended after the auto-derived class

```js
// Story: slot function returns enriched object → class derived automatically
export const Default = {
  args: {
    _includes: {
      item: () => createImage({ src: '/img.jpg' }), // _class: 'image' propagates
    }
  }
};
// Renders: <div class="image"><img src="/img.jpg"></div>
```

#### `_resourceDecorations`

Override or configure decoration per slot key or `resourceType` at runtime:

```js
args: {
  _resourceDecorations: {
    item: {
      decorationTagName: 'div',
      cssClassName: 'extra-class',
      decoration: true,
    },
    // or keyed by resourceType:
    'mysite/components/container': {
      decorationTagName: 'section',
    },
  }
}
```

Set `decoration: false` to suppress the decoration tag even when `decorationTagName` is set in HTL.



Use `generateDts` (or the `--dts` CLI flag) to emit a declaration file alongside the generated JS. When `__slots__` is present, `_includes` is typed with the known slot keys:

```ts
// header.template.d.ts
export declare function createHeader(args?: {
  model?: any;
  _includes?: {
    'hero'?: string | (() => string);
    'footer'?: string | (() => string);
    [key: string]: string | (() => string) | undefined;
  };
}): { toString(): string; _class: string; _resourceType: string | null; _slots: string[] | undefined; _decorationTagName: undefined; _attrs: {} };
export declare const __slots__: ['hero', 'footer'];
```

When no static slots are present, `_includes` falls back to `Record<string, string | (() => string) | undefined>`.

---

## `data-sly-call`

Calls a named template passing parameters. The binding declared via `data-sly-use` becomes a function parameter — pass the imported template module as its value.

```html
<!-- HTL -->
<sly data-sly-use.template="default.html"
     data-sly-call="${template.default @ model=item}"></sly>
```

Generated:

```js
${require('./default.html').createDefault?.({ model: item, _includes }) ?? ''}
```

When the host element is not `<sly>`, the call output is wrapped in that element:

```html
<div class="wrapper" data-sly-call="${myFn @ text='Hi'}"></div>
```

```js
<div class="wrapper">${myFn?.({ text: 'Hi', _includes }) ?? ''}</div>
```

In the story, pass the imported template function:

```js
import { createDefault } from '../default.html';

export const Default = {
  args: {
    template: { default: createDefault },
    item: { title: 'Card Title', url: '/path' },
  }
}
```

---

## `data-sly-include`

Includes another HTL file at runtime. The loader generates a slot in the `_includes` map.

```html
<!-- Literal path -->
<sly data-sly-include="./header.html"></sly>

<!-- Dynamic path -->
<sly data-sly-include="${model.templatePath}"></sly>

<!-- Arguments are forwarded to the slot function -->
<sly data-sly-include="./header.html @ wcmmode='edit'"></sly>

<!-- appendPath / prependPath -->
<sly data-sly-include="${'partials' @ appendPath='template.html'}"></sly>
<sly data-sly-include="${'template.html' @ prependPath='partials'}"></sly>
```

Generated:

```js
// Literal path
${_incSlot(_includes, './header.html')}

// Dynamic path
${_incSlot(_includes, model?.templatePath)}

// With args
${_incSlot(_includes, './header.html', { wcmmode: 'edit' })}

// appendPath/prependPath — resolved at compile time when both sides are string literals
${_incSlot(_includes, 'partials/template.html')}
// Dynamic operands fall back to a runtime helper
${_incSlot(_includes, _htlJoinPaths('partials', undefined, model?.tpl))}
```

In the story, pass either a function (component factory) or a plain string:

```js
import { createHeader } from '../header.html';

export const Default = {
  args: {
    _includes: {
      './header.html': createHeader,
      './footer.html': () => '<footer>Footer content</footer>',
      './banner.html': '<div class="banner">Static banner</div>', // plain string also works
    }
  }
}
```

---

## i18n (internationalization)

HTL expressions with `@ i18n` are converted into runtime dictionary lookups. Pass a JSON dictionary via the `_i18n` parameter to translate strings:

```html
<!-- HTL -->
<span>${'Read more' @ i18n}</span>
<a title="${'Go home' @ i18n}" href="/">...</a>
```

Generated:

```js
<span>${_i18n?.['Read more'] ?? 'Read more'}</span>
<a title="${_htlAttr(_i18n?.['Go home'] ?? 'Go home')}" href="/">...</a>
```

In the story, pass the dictionary as `_i18n`:

```js
import dict from './i18n/es.json';

export const Spanish = {
  args: {
    _i18n: dict,
  }
}
```

Example `i18n/es.json`:

```json
{
  "Read more": "Leer más",
  "Go home": "Ir al inicio",
  "Title": "Título"
}
```

When no dictionary is passed (or when a key is missing), the original string is used as fallback.

### Pluralization

Add `count=<expr>` alongside `@ i18n` to select the plural or singular form at runtime:

```html
<!-- HTL -->
<span>${'item' @ i18n, count=n}</span>
```

Generated:

```js
<span>${_htlI18nPlural('item', n, _i18n)}</span>
```

The dictionary entry for a pluralizable key is an array `[singular, plural]`:

```json
{
  "item": ["1 item", "{0} items"]
}
```

`_htlI18nPlural` picks index `0` when `count === 1` and index `1` otherwise, then substitutes `{0}` with the count value.

### Locale fallback chains

When targeting a specific locale (e.g. `es_MX`), you can supply a chain of dictionaries. Keys from earlier dictionaries override later ones, so the most specific locale should come first.

**Programmatic API:**

```ts
const primary  = parseI18nXml(fs.readFileSync('i18n/es_MX.xml', 'utf8'));
const fallback = parseI18nXml(fs.readFileSync('i18n/es.xml', 'utf8'));

const js = transpile(source, {
  filename: 'card.html',
  i18nDict: primary,
  i18nFallbackDicts: [fallback],
});
```

**Webpack loader (`i18nFallbackPaths` option):**

```js
use: {
  loader: require.resolve('htl-to-js/loader'),
  options: {
    i18nPath: path.resolve(__dirname, 'i18n/es_MX.xml'),
    i18nFallbackPaths: [
      path.resolve(__dirname, 'i18n/es.xml'),
      path.resolve(__dirname, 'i18n/en.xml'),
    ],
  },
}
```

**CLI — multiple `--i18n` flags (first = primary, rest = fallbacks):**

```bash
npx htl-gen --i18n i18n/es_MX.xml --i18n i18n/es.xml --i18n i18n/en.xml "src/**/*.html"
```

### Loading a dictionary from AEM XML

AEM stores i18n dictionaries as JCR XML files (`en.xml`, `es.xml`, etc.) with the standard `sling:MessageEntry` format:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<jcr:root xmlns:jcr="http://www.jcp.org/jcr/1.0"
          xmlns:sling="http://sling.apache.org/jcr/sling/1.0"
          xmlns:mix="http://www.jcp.org/jcr/mix/1.0"
          jcr:primaryType="sling:Folder"
          jcr:language="es"
          jcr:mixinTypes="[mix:language]">
  <Read_more
      jcr:primaryType="sling:MessageEntry"
      sling:key="Read more"
      sling:message="Leer más"/>
  <Go_home
      jcr:primaryType="sling:MessageEntry"
      sling:key="Go home"
      sling:message="Ir al inicio"/>
</jcr:root>
```

You can load such a file directly without converting it to JSON:

**Webpack loader (`i18nPath` option):**

```js
use: {
  loader: require.resolve('htl-to-js/loader'),
  options: {
    i18nPath: path.resolve(__dirname, 'ui.i18n/es.xml'),
  }
}
```

The dictionary is baked into the generated module as the default value for `_i18n`. Webpack watches the XML file for changes in watch mode. Stories can still override `_i18n` at runtime to test other languages.

**CLI (`--i18n` flag):**

```bash
npx htl-gen --i18n ui.i18n/es.xml "components/**/*.html"
```

**Programmatic API (`i18nDict` option):**

```ts
import { transpile } from 'htl-to-js';
import { parseI18nXml } from 'htl-to-js/parseI18nXml';
import fs from 'fs';

const dict = parseI18nXml(fs.readFileSync('ui.i18n/es.xml', 'utf8'));
const js = transpile(source, { filename: 'accordion.html', i18nDict: dict });
```

`parseI18nXml` also handles a simple `<entry key="...">value</entry>` format as a fallback.

---

## `data-sly-repeat` vs `data-sly-list`

Both iterate over a list, but they differ in what gets repeated:

| | `data-sly-repeat` | `data-sly-list` |
|---|---|---|
| **Repeats** | The entire host element | Only inner content |
| **Outer tag** | Rendered once per item | Rendered once total |

```html
<!-- repeat: <li> repeated per item -->
<li data-sly-repeat.item="${items}">${item}</li>

<!-- list: <ul> once, <li> repeated per item -->
<ul data-sly-list.item="${items}"><li>${item}</li></ul>
```

Both support:
- Null items are automatically skipped
- A `${itemList}` status object with `index`, `count`, `first`, `last`, `middle`, `odd`, `even`
- Combined `data-sly-test.var` + `data-sly-repeat` on the same element (test var is hoisted before the loop in a scoped IIFE)

### Iteration control: `begin`, `end`, `step`

Both directives accept `begin`, `end`, and `step` options to control which items are iterated:

```html
<!-- Skip the first item (begin is 0-based, inclusive) -->
<ul data-sly-list.item="${items @ begin=1}"><li>${item}</li></ul>

<!-- Stop after the second item (end is 0-based, inclusive) -->
<ul data-sly-list.item="${items @ end=1}"><li>${item}</li></ul>

<!-- Every other item -->
<ul data-sly-list.item="${items @ step=2}"><li>${item}</li></ul>

<!-- Combined -->
<ul data-sly-list.item="${items @ begin=1, end=5, step=2}"><li>${item}</li></ul>
```

Options can also be dynamic expressions:

```html
<ul data-sly-list.item="${items @ begin=model.start, end=model.end}"><li>${item}</li></ul>
```

---

## Options

Both the `transpile()` function and the webpack loader accept the following options:

### `omitAttrs`

Array of regular expressions matching attribute names to exclude from output.

**Override in webpack loader:**

```js
config.module.rules.push({
  test: /\.html$/,
  include: /jcr_root[\\/]apps/,
  use: {
    loader: require.resolve('htl-to-js/loader'),
    options: {
      omitAttrs: [
        /^data-cmp-data-layer$/,
        /^data-my-custom-attr/,
      ]
    }
  }
});
```

Pass `omitAttrs: []` to disable filtering entirely.

### `wrapperClass`

Wraps the component output in a `<div>` with a CSS class, similar to how AEM wraps component markup.

| Value | Behavior |
|---|---|
| `true` | Auto-derives the class from the parent folder name (e.g. `/apps/mysite/image/image.html` → `"image"`) |
| `'custom classes'` | Uses the provided string as the class attribute |
| `false` / omitted | No wrapper (default — backward compatible) |

```js
use: {
  loader: require.resolve('htl-to-js/loader'),
  options: {
    wrapperClass: true,
  }
}
```

At runtime, the generated function also accepts `_wrapperClass` to append extra classes to the wrapper. This is useful when a parent component (like a responsive grid) needs to inject layout classes into its children:

```js
const html = createColumn({ _wrapperClass: 'aem-GridColumn aem-GridColumn--default--12' });
// → <div class="column aem-GridColumn aem-GridColumn--default--12">...</div>
```

### `resourceWrappers`

Object mapping resource keys **or `resourceType` paths** to CSS classes (or configuration objects) that wrap `data-sly-resource` slot output. Mimics the extra wrapper divs that AEM's responsive grid adds around its children.

HTL options on `data-sly-resource` are forwarded to the slot function, so wrappers can react to values such as `wcmmode` or `resourceType`-driven paths.

Keys are matched in this order:
1. **Resource name** — the value in the expression (e.g. `'par'` from `data-sly-resource="${'par' @ ...}"`)
2. **`resourceType`** — the `@resourceType` option value (e.g. `'mysite/components/responsivegrid'`)

**Simple string value** — wraps the slot output in a `<div>` with that class:

```js
options: {
  resourceWrappers: {
    'mysite/components/responsivegrid': 'aem-Grid aem-Grid--12 aem-Grid--default--12',
  }
}
```

**Object value** — wraps the slot output and injects a class into the first element of each child:

```js
options: {
  resourceWrappers: {
    'mysite/components/responsivegrid': {
      wrapper: 'aem-Grid aem-Grid--12 aem-Grid--default--12',
      childClass: 'aem-GridColumn aem-GridColumn--default--12',
    }
  }
}
```

- **`wrapper`** — CSS class for the extra `<div>` added around the slot HTML
- **`childClass`** — CSS class injected into the first element of the child component's output (merges with existing `class` or creates one)

At runtime, the `_resourceWrappers` parameter can override or extend the static config.

### `format`

Controls the module format of the generated code. Defaults to `'cjs'`.

| Value | Output |
|---|---|
| `'cjs'` (default) | `module.exports = { createFoo }` |
| `'esm'` | `export { createFoo }` |

```ts
const js = transpile(source, { filename: 'card.html', format: 'esm' });
```

In the webpack loader pass it as a loader option:

```js
use: {
  loader: require.resolve('htl-to-js/loader'),
  options: { format: 'esm' },
}
```

In the CLI use `--esm`:

```bash
npx htl-gen --esm "components/**/*.html"
```

When `format: 'esm'` and `data-sly-use` references a local `.js` or `.json` file, the generated code emits `import` declarations instead of `require()` calls.

---

### `modelTransforms`

Object mapping `data-sly-use` class-name patterns to property injections. Enables build-time property merging based on the use class. All keys are merged as computed properties into the model variable.

**Example — set default model values (string expression):**

```js
const modelTransforms = {
  'LayoutContainer': {
    layout: "'RESPONSIVE_GRID'",
  },
};
```

Any component that uses `data-sly-use.x="com.example.LayoutContainer"` will get `layout` set to `'RESPONSIVE_GRID'` as default (can be overridden at runtime). The value is a JS expression string where `model` is replaced with the actual variable name.

**Function values** — for cases where the expression depends on the variable name, a function `(varName: string) => string` can be used instead:

```js
const modelTransforms = {
  'LayoutContainer': {
    // Equivalent to the string form above
    layout: () => "'RESPONSIVE_GRID'",

    // The varName argument holds the actual use-binding identifier
    id: (varName) => `${varName}?._internalId ?? ''`,
  },
};
```

The function receives the actual variable name (e.g. `container`) and must return a JS expression string. This is useful when the transform expression needs to reference the variable precisely.

**Direct code callbacks** — `modelTransforms` also accepts direct callbacks such as `() => 'RESPONSIVE_GRID'`, `({ model }) => ...`, or `({ model, _includes, varName }) => ...`. In this mode the callback body is serialized into the generated module, and `model` is replaced with the actual use-binding variable:

```js
const modelTransforms = {
  LayoutContainer: {
    layout: () => 'RESPONSIVE_GRID',
  },
  ColContainer: {
    id: ({ model }) => model?._internalId ?? '',
    columns: ({ model }) => {
      const count = model?.columns || 1;
      return Array.from({ length: count }, (_, index) => ({
        path: 'par_' + index,
      }));
    },
  },
};
```

The supported destructured bindings are:

- `model` — the model variable from `data-sly-use` (e.g. `container`, `tabs`, …)
- the variable name itself — same as `model` (e.g. `({ tabs })` when the use-binding is `tabs`)
- `_includes` — the component's `_includes` parameter
- `varName` — the variable name as a string literal (e.g. `'tabs'`)
- any other identifier — forwarded to `_rest.<identifier>`, i.e. any other prop passed to the component

The `_rest` fallback is rarely needed; the common pattern is to just destructure the model variable by name (as in the `Tabs` example above).


**Special key `_includes`** — computes `_includes` slot entries from model data. Unlike regular keys (which are merged into the model object), `_includes` is assigned to the `_includes` parameter directly. Runtime `_includes` take precedence over computed ones.

Because the callback is serialized and runs inside the generated function body, it has access to the model variable and all other component parameters:

```js
const modelTransforms = {
  // String expression — 'model' is replaced with the actual use-binding variable
  'ColumnModel': {
    _includes: "Object.fromEntries((model.columns || []).map((col, i) => [col.path, () => (model._content || [])[i] || '']))",
  },

  // Direct callback — bindings are resolved at serialization time
  'Tabs': {
    _includes: ({ tabs }) =>          // 'tabs' matches the varName → the model variable
      Object.fromEntries(
        (tabs?.children || tabs?.items || []).map((item) => [
          item.resource ?? item.id ?? item.name,
          () => (typeof item.content === 'function' ? item.content() : (item.content || ''))
        ])
      ),
  },

  // Access other component params via _rest
  'ImageModel': {
    _includes: ({ model, someOtherParam }) =>  // someOtherParam → _rest.someOtherParam
      ({ image: model.imageHtml }),
  },
};
```

### `content` shorthand

`content` is a shorthand for `_includes` — instead of building the slot map manually, pass a value directly and the runtime routes it into the right slot. All the same value types that `_includes` supports are accepted:

```js
// function → called and routed to the first slot
createContainer({ content: () => createText() })

// array → same as _includes: { par: [...] }, distributes across par_0, par_1, …
createContainer({
  content: [createText(), createImage()],
})

// 2D array → inner arrays concatenate within each slot
createContainer({
  content: [
    [createText(), createImage()],  // → par_0
    [createCard()],                  // → par_1
  ],
})

// object → spread directly into _includes (explicit key routing)
createContainer({
  content: ({ model }) => ({
    header: () => createHeader({ title: model.title }),
    footer: () => createFooter(),
  }),
})
```

Explicit `_includes` keys always take priority over `content`.

#### Function parameters in `content`

Unlike `_includes` slot functions (which only receive `@options`), a `content` function receives **all the parent component's props** — `model`, `_includes`, and any other parameters the component accepts:

```js
// content function receives { model, ...allOtherProps }
createContainer({
  model: { title: 'Hero' },
  content: ({ model }) => createHero({ title: model.title }),
  //         ^^^^^^^  the full parent props are available here
})

// Useful for computing slot content from the model
createContainer({
  model: { items: ['a', 'b', 'c'] },
  content: ({ model }) => model.items.map(item => createCard({ label: item })),
})
```

This is why `content` as a story arg is useful for data-driven slot composition at runtime — when you need to pass data down from the story, `content` receives all the parent component's props automatically.

**When to use `content` vs `_includes` in `modelTransforms`:**

- Use **`content` story arg** when the slot data comes from the story itself (runtime)
- Use **`_includes` in `modelTransforms`** when the slot data is derived from the model (build-time, applies to every story using that component)

```js
// modelTransforms: compute _includes from model data at runtime inside the generated function
const modelTransforms = {
  'Tabs': {
    _includes: ({ tabs }) =>
      Object.fromEntries(
        (tabs?.children || tabs?.items || []).map((item) => [
          item.resource ?? item.id ?? item.name,
          () => (typeof item.content === 'function' ? item.content() : (item.content || ''))
        ])
      ),
  },
};

// story: pass content directly from story args
export const Default = {
  args: {
    content: () => createText({ text: 'Hello' }),
  }
};
```

### `fileOverrides`

Object mapping HTL file names to expression strings (or configuration objects) that replace `data-sly-use.X="file.html"` + `data-sly-call` references. Useful for replacing AEM template files (like `responsiveGrid.html`) that don't exist in your Storybook build.

**Simple string value** — replaces the `require()` call with the provided expression:

```js
options: {
  fileOverrides: {
    'responsiveGrid.html': "{ responsiveGrid: ({ container, _includes }) => _includes?.content?.() ?? '' }",
  }
}
```

**Object value with `htl`** — provides HTL content that is transpiled inline (no file on disk needed). The templates are compiled and inlined into the output module:

```js
options: {
  fileOverrides: {
    'responsiveGrid.html': {
      htl: `<template data-sly-template.responsiveGrid="\${ @ container }">
        <div id="\${container.id}" class="cmp-container">
          <sly data-sly-resource="\${'content' @ resourceType='wcm/foundation/components/responsivegrid'}"></sly>
        </div>
      </template>`,
    },
  },
}
```

The HTL content must contain `data-sly-template` definitions. The transpiler compiles them and generates the functions at module scope. Since the template uses `data-sly-resource` with `@resourceType`, the `resourceWrappers` config applies automatically inside the template.

**Object value with `expression`** — provides a raw JS expression string instead of HTL:

```js
options: {
  fileOverrides: {
    'responsiveGrid.html': {
      expression: "{ responsiveGrid: ({ container, _includes }) => _includes?.content?.() ?? '' }",
    },
  },
}
```

When the transpiler encounters `data-sly-use.tpl="responsiveGrid.html"`, instead of generating a `require()` call, it uses the provided value as the default for the `tpl` parameter. The `data-sly-call="${tpl.responsiveGrid @ ...}"` then calls the function directly.

The override can be replaced at runtime by passing a different value for the parameter:

```js
// Use default from fileOverrides
const html = createContainer();

// Override at runtime
const html = createContainer({
  responsiveGridTemplate: { responsiveGrid: myCustomFn },
});
```

---

## AEM component composition example

Combining `wrapperClass`, `resourceWrappers`, `modelTransforms`, and `fileOverrides` reproduces AEM's full component nesting structure.

**Config (shared across all components):**

```js
const options = {
  wrapperClass: true,
  resourceWrappers: {
    'wcm/foundation/components/responsivegrid': {
      wrapper: 'aem-Grid aem-Grid--12 aem-Grid--default--12',
      childClass: 'aem-GridColumn aem-GridColumn--default--12',
    },
  },
  modelTransforms: {
    'LayoutContainer': {
      layout: "'RESPONSIVE_GRID'",
    },
  },
  fileOverrides: {
    'responsiveGrid.html': {
      htl: `<template data-sly-template.responsiveGrid="\${ @ container }">
        <div id="\${container.id}" class="cmp-container">
          <sly data-sly-resource="\${'content' @ resourceType='wcm/foundation/components/responsivegrid'}"></sly>
        </div>
      </template>`,
    },
  },
};
```

**Container HTL:**

```html
<sly data-sly-use.container="com.adobe.cq.wcm.core.components.models.LayoutContainer">
  <sly data-sly-test.responsive="${container.layout == 'RESPONSIVE_GRID'}"
       data-sly-use.responsiveGridTemplate="responsiveGrid.html"
       data-sly-call="${responsiveGridTemplate.responsiveGrid @ container=container}"></sly>
  <sly data-sly-test="${!responsive}"
       data-sly-use.simpleTemplate="simple.html"
       data-sly-call="${simpleTemplate.simple @ container=container}"></sly>
</sly>
```

**Column HTL:**

```html
<div class="cmp-column">Sample Text</div>
```

**Story:**

```js
import { createContainer } from '../container/container.html';
import { createColumn } from '../column/column.html';

export const Default = {
  render: () => createContainer({
    _includes: {
      content: () => createColumn(),
    },
  }),
};
```

**Rendered HTML:**

```html
<div class="container">                                      <!-- wrapperClass -->
  <div class="cmp-container">                                  <!-- from responsiveGrid.html htl template -->
    <div class="aem-Grid aem-Grid--12 aem-Grid--default--12">  <!-- resourceWrappers.wrapper -->
      <div class="cmp-column aem-GridColumn aem-GridColumn--default--12"> <!-- resourceWrappers.childClass -->
        Sample Text
      </div>
    </div>
  </div>
</div>
```

Each option has a single responsibility:

| Option | Responsibility |
|---|---|
| `wrapperClass` | Component wrapper `<div>` with CSS class |
| `resourceWrappers` | Wraps `data-sly-resource` output with grid/column divs |
| `modelTransforms` | Model property defaults (e.g. `layout: 'RESPONSIVE_GRID'`) |
| `fileOverrides` | Replaces `data-sly-use="file.html"` with inline HTL or JS expressions |

---

## Programmatic API

```ts
import { transpile } from 'htl-to-js';
import { parseI18nXml } from 'htl-to-js/parseI18nXml';
import fs from 'fs';

const source = fs.readFileSync('accordion.html', 'utf8');
const jsModule = transpile(source, {
  filename: 'accordion.html',
  format: 'cjs',           // 'cjs' (default) | 'esm'
  omitAttrs: [],
  i18nDict: {},            // bake a dictionary into the module
  i18nFallbackDicts: [],   // additional fallback dictionaries (lower priority)
});

console.log(jsModule);
```

---

## CLI

Generate `.template.js` files alongside their `.html` source:

```bash
npx htl-gen "src/**/*.html"
```

Watch mode:

```bash
npx htl-gen --watch "components/**/*.html"
```

Output files are placed next to the source:
```
accordion.html  →  accordion.template.js
                   accordion.template.d.ts
card/default.html  →  card/default.template.js
                      card/default.template.d.ts
```

Each `.d.ts` file re-exports the function signatures from the generated module so TypeScript consumers get full type information without needing `declare module '*.html'` shims.

---

## Known limitations

- **`data-sly-call` across files** — the called template must be imported and passed explicitly via args; cross-file resolution at build time is not supported unless the file is declared via `data-sly-use`.
- **Java expressions** in `data-sly-use` — the class path is ignored; the binding name becomes a function parameter.
- **`data-sly-use` with `@` defaults** — the default values are extracted as destructuring defaults, but complex expressions are not supported.

---

## License

[MIT](./LICENSE)
