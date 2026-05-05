# htl-to-js

[![npm version](https://img.shields.io/npm/v/htl-to-js.svg)](https://www.npmjs.com/package/htl-to-js)
[![license](https://img.shields.io/npm/l/htl-to-js.svg)](./LICENSE)

Webpack loader and CLI that transpiles AEM HTL (Sightly) templates into JavaScript functions returning template literals.

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

---

## HTL directive support

| Directive | Behavior |
|---|---|
| `data-sly-use.name="..."` | Becomes a function parameter |
| `data-sly-test="${cond}"` | Conditional rendering via ternary |
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

Both `data-sly-repeat` and `data-sly-list` support bare forms (without `.varName`) that default to `item` as the iteration variable. They also provide a `${itemList}` status object with `index`, `count`, `first`, `last`, `odd`, and `even` properties.

### Expression conversions

| HTL | Generated JS |
|---|---|
| `${expr @ context='html'}` | `${expr}` (context options stripped) |
| `${expr @ context='urlencode'}` | `${encodeURIComponent(expr ?? '')}` (URL-encodes the value) |
| `${'string' @ i18n}` | `${_i18n?.['string'] ?? 'string'}` (dictionary lookup) |
| `${list.size}` | `${list.length}` |
| `${obj.jcr:title}` | `${obj?.['jcr:title']}` |
| `${tags @ join=', '}` | `${(tags).join(', ')}` |
| `${'pattern {0}/{1}' @ format=[a, b]}` | `${a + '/' + b}` |
| `${key in obj}` | `${(obj && key in obj)}` (null-safe) |

### HTML escaping

Attribute values are automatically escaped via the `_htlAttr` helper:
- `&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`, `"` → `&quot;`
- Object values are serialized with `JSON.stringify`
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
  return /* html */`<div class="cmp-accordion ${_htlAttr(properties?.theme)}" id="${_htlAttr(accordion?.id)}">${(accordion?.items?.length > 0) ? `${((accordion?.items) || []).map((item, _i, _arr) => { if (item == null) return ''; const itemList = { index: _i, count: _i + 1, first: _i === 0, last: _i === _arr.length - 1, odd: (_i + 1) % 2 !== 0, even: (_i + 1) % 2 === 0 }; return `<div><span>${(item?.title) ?? ''}</span></div>`; }).join('')}` : ''}</div>`;
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
  return /* html */`<a class="template" href="${_htlAttr(model?.url)}">
    <h3>${(model?.title) ?? ''}</h3>
  </a>`;
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
```

```js
// Generated
${_inc(_includes?.['header'])}
${_inc(_includes?.[model?.path])}
```

Pass content via `_includes` in your story args. Both plain strings and functions are accepted:

```js
export const Default = {
  args: {
    _includes: {
      header: '<nav>Navigation</nav>',         // plain string
      sidebar: () => '<aside>Sidebar</aside>', // or a function
    }
  }
}
```

### `__slots__`

When a template uses static `data-sly-resource` keys (string literals), the generated module also exports a `__slots__` array listing those keys. This allows parent components to discover which slots a child expects without importing and running the template:

```js
import { __slots__ } from '../header/header.template.js';
// e.g. ['hero', 'footer']
```

Dynamic keys (expressions like `${model.path}`) are not included — only compile-time string literals appear in `__slots__`.

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
```

Generated:

```js
// Literal path
${_inc(_includes?.['./header.html'])}

// Dynamic path
${_inc(_includes?.[model?.templatePath])}
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
- A `${itemList}` status object with `index`, `count`, `first`, `last`, `odd`, `even`
- Combined `data-sly-test.var` + `data-sly-repeat` on the same element (test var is hoisted before the loop in a scoped IIFE)

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

**Special key `_includes`** — computes `_includes` slot entries from model data. Unlike regular keys (which are merged into the model object), `_includes` is assigned to the `_includes` parameter directly. Runtime `_includes` take precedence over computed ones.

```js
const modelTransforms = {
  'ColumnModel': {
    _includes: "Object.fromEntries((model.columns || []).map((col, i) => [col.path, () => (model._content || [])[i] || '']))",
  },
};
```

This is the only special key — it belongs in `modelTransforms` because the value is computed from the model data, unlike `resourceWrappers` or `wrapperClass` which are static configuration.

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
import fs from 'fs';

const source = fs.readFileSync('accordion.html', 'utf8');
const jsModule = transpile(source, {
  filename: 'accordion.html',
  omitAttrs: [],
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

- **`data-sly-include` with args** — passing parameters to included files (`@ wcmmode=wcmmode`) is not supported; only the path is used.
- **`data-sly-call` across files** — the called template must be imported and passed explicitly via args; cross-file resolution at build time is not supported unless the file is declared via `data-sly-use`.
- **Java expressions** in `data-sly-use` — the class path is ignored; the binding name becomes a function parameter.
- **`data-sly-use` with `@` defaults** — the default values are extracted as destructuring defaults, but complex expressions are not supported.

---

## License

[MIT](./LICENSE)
