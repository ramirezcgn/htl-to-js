import { parseDocument } from 'htmlparser2';
import { createContext, walkNodes } from './walker';
import type { WalkerContext } from './walker';
import type { SetDecl } from './directives';
import { parseDirectives } from './directives';
import { extractExprs } from './expr';
import fs from 'node:fs';
import path from 'node:path';

/* eslint-disable @typescript-eslint/no-explicit-any */

const DEFAULT_OMIT_ATTRS = [
  /^data-cmp-data-layer$/, // analytics data layer JSON
  /^data-placeholder-text$/, // author mode placeholder
  /^data-panelcontainer$/, // author mode panel container
  /^data-component-name$/, // AEM component tracking
  /^data-region-id$/, // analytics region tracking
  /^data-emptytext$/, // author mode empty text
];

const AEM_IMPLICITS: Record<string, string> = {
  wcmmode: '{ edit: false, disabled: true, preview: false }',
  properties: '{}',
  pageProperties: '{}',
  inheritedPageProperties: '{}',
  component: '{}',
  currentDesign: '{}',
  currentStyle: '{}',
  currentPage: '{}',
  resource: '{}',
  model: '{}',
  _includes: '{}',
  _i18n: '{}',
  _wrapperClass: "''",
  _resourceWrappers: '{}',
  _resourceDecorations: '{}',
  request:
    "{ requestPathInfo: { selectorString: '', suffix: '', resourcePath: ''  }, contextPath: ''  }",
};

// Canonical AEM paragraph-system slot names checked in priority order.
const PARSYS_SLOTS = new Set([
  'par',
  'parsys',
  'content',
  'main',
  'centerpar',
  'leftpar',
  'rightpar',
]);

const DEFAULT_FUNCTION_META = { _class: '', _resourceType: null } as const;

const EXPAND_SLY_RE = /<sly\b([^>]*?)\/>/g;
const SLOT_KEYS_RE =
  /_(?:inc|file)Slot\(_includes,\s*'([^']+)'|_wrapResource\('([^']+)',\s*_includes,/g;
const RESOURCE_SLOT_KEYS_RE = /_wrapResource\('([^']+)',\s*_includes,/g;

interface TranspileOptions {
  filename?: string;
  omitAttrs?: RegExp[];
  i18nDict?: Record<string, string>;
  i18nFallbackDicts?: Record<string, string>[];
  modelTransforms?: Record<string, Record<string, ModelTransformValue>>;
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
  format?: 'cjs' | 'esm';
  sourceURL?: boolean;
  usePathCaching?: boolean;
}

interface ParamDecl {
  name: string;
  default: string;
}

interface TemplateInfo {
  name: string;
  params: string[];
  node: any;
}

type LegacyModelTransformFn = (varName: string) => string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DirectModelTransformFn = (bindings: any) => any;
type ModelTransformValue =
  | string
  | LegacyModelTransformFn
  | DirectModelTransformFn;

/**
 * Transpiles an HTL source string into a JavaScript module that exports
 * a template function (or multiple named template functions).
 *
 * @param htlSource  - Raw HTL file content
 * @param options
 * @returns A valid CJS module source string
 */
export function transpile(
  htlSource: string,
  {
    filename = 'component',
    omitAttrs = DEFAULT_OMIT_ATTRS,
    i18nDict,
    i18nFallbackDicts,
    modelTransforms = {},
    wrapperClass,
    resourceWrappers,
    resourceDecorations,
    fileOverrides = {},
    format = 'cjs',
    sourceURL: emitSourceURL = true,
    usePathCaching = false,
  }: TranspileOptions = {}
): string {
  const expandedSource = htlSource.replaceAll(EXPAND_SLY_RE, '<sly$1></sly>');
  const { normalized: normalizedSource, restoreMap } =
    normalizeSetVarCasing(expandedSource);
  const document = parseDocument(normalizedSource);

  const originalTemplateNames = extractOriginalTemplateNames(normalizedSource);
  const templates = findNamedTemplates(document, originalTemplateNames);

  const sourceDir = path.dirname(path.resolve(filename));

  const serializedFileOverrides: Record<string, string> = {};
  for (const [key, val] of Object.entries(fileOverrides)) {
    if (typeof val === 'string') {
      serializedFileOverrides[key] = val;
    } else if (val.htl) {
      serializedFileOverrides[key] = transpileInlineHtl(
        val.htl,
        omitAttrs,
        sourceDir,
        modelTransforms,
        serializedFileOverrides
      );
    } else if (val.expression) {
      serializedFileOverrides[key] = val.expression;
    }
  }

  const effectiveI18nDict = i18nFallbackDicts?.length
    ? Object.assign({}, ...i18nFallbackDicts, i18nDict ?? {})
    : i18nDict;
  const i18nDefault = effectiveI18nDict
    ? JSON.stringify(effectiveI18nDict)
    : undefined;

  let body: string;
  if (templates.length > 0) {
    body = transpileNamedTemplates(templates, omitAttrs, sourceDir, {
      modelTransforms,
      fileOverrides: serializedFileOverrides,
      i18nDefault,
      format,
      usePathCaching,
    });
  } else {
    body = transpileSingleTemplate(document, filename, omitAttrs, sourceDir, {
      modelTransforms,
      wrapperClass,
      fileOverrides: serializedFileOverrides,
      i18nDefault,
      format,
      usePathCaching,
    });
  }

  const banner = `// AUTO-GENERATED from ${path.basename(filename)} — DO NOT EDIT\n\n`;
  const helpers = [
    `const _htlAttr = (v) => v == null ? '' : (Array.isArray(v) ? JSON.stringify(v).replace(/"/g, '&quot;') : typeof v === 'object' ? JSON.stringify(v).replace(/"/g, '&quot;') : String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'));`,
    `const _htlText = (v) => { if (v == null) return ''; const s = Array.isArray(v) ? v.map(x => x == null ? '' : typeof x === 'object' ? JSON.stringify(x) : String(x)).join(',') : typeof v === 'object' ? JSON.stringify(v) : String(v); return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };`,
    `const _htlCtx = (v, ctx) => { if (ctx === 'html' || ctx === 'unsafe') return String(v ?? ''); if (ctx === 'number') { const n = Number(v); return (!v && v !== 0) || isNaN(n) ? '' : String(n); } if (ctx === 'uri') { try { return encodeURI(String(v ?? '')).replace(/"/g, '&quot;'); } catch { return ''; } } return _htlText(v); };`,
    `const _htlCtxAttr = (v, ctx) => { if (ctx === 'html' || ctx === 'unsafe') return String(v ?? ''); if (ctx === 'uri') return _htlUri(v); if (ctx === 'number') return _htlNum(v) ?? ''; return _htlAttr(v); };`,
    `const _htlDynAttrCtx = (name, v, ctx) => { if (ctx === 'html' || ctx === 'unsafe') { if (v == null || v === false) return ''; if (v === true) return ' ' + name; return ' ' + name + '="' + String(v) + '"'; } return _htlDynAttr(name, ctx === 'uri' ? _htlUri(v) : ctx === 'number' ? _htlNum(v) : v); };`,
    `const _htlUri = (v) => { if (v == null) return ''; try { return encodeURI(String(v)).replace(/"/g, '&quot;'); } catch { return ''; } };`,
    `const _htlIn = (l, r) => { if (typeof r === 'string') return r.includes(String(l)); if (Array.isArray(r)) return r.includes(l); return r != null && (l in r); };`,
    `const _htlSize = (v) => v == null ? 0 : (Array.isArray(v) || typeof v === 'string') ? v.length : v?.size !== undefined ? v.size : v?.length ?? 0;`,
    `const _htlNum = (v) => { if (v == null || typeof v === 'boolean' || Array.isArray(v)) return null; const n = Number(v); return isNaN(n) ? null : String(n); };`,
    String.raw`const _htlJoinPaths = (base, prepend, append) => { let p = String(base ?? ''); if (prepend) { const s = String(prepend); p = s.replace(/\/$/, '') + '/' + p.replace(/^\//, ''); } if (append) { const s = String(append); p = p.replace(/\/$/, '') + '/' + s.replace(/^\//, ''); } return p; };`,
    `const _htlSlice = (arr, begin, end, step) => { const a = arr || []; const b = begin != null ? Number(begin) : 0; const e = end != null ? Number(end) : a.length - 1; const s = step != null ? Math.max(1, Number(step)) : 1; return a.filter((_, i) => i >= b && i <= e && (i - b) % s === 0); };`,
    `const _htlI18nPlural = (key, count, dict) => { if (key == null) return ''; const n = Number(count); const tmpl = (n === 1 ? dict?.[key] : (dict?.[key + '_plural'] ?? dict?.[key])) ?? String(key); return String(tmpl).replace('{0}', String(n)); };`,
    `const _htlDynAttr = (name, val) => { if (val == null || val === false) return ''; if (val === true) return ' ' + name; return ' ' + name + '="' + _htlAttr(val) + '"'; };`,
    `const _htlSpreadAttrs = (obj) => { if (!obj || typeof obj !== 'object') return ''; return Object.entries(obj).map(([k, v]) => _htlDynAttr(k, v)).join(''); };`,
    `const _inc = (v) => typeof v === 'function' ? v() : String(v ?? '');`,
    `const _arrJoin = (v) => Array.isArray(v) ? v.map(_arrJoin).join('') : (v == null ? '' : (typeof v === 'object' ? (v.toString !== Object.prototype.toString ? String(v) : JSON.stringify(v)) : String(v)));`,
    String.raw`const _incSlot = (inc, key, params) => { if (!inc) return ''; const v = inc[key]; if (v != null) return _arrJoin(typeof v === 'function' ? v(params) : v); if (typeof key === 'string') { const m = key.match(/^(.+)_(\d+)$/); if (m) { const b = inc[m[1]]; if (b != null) { const a = typeof b === 'function' ? b(params) : b; if (Array.isArray(a)) return _arrJoin(a[+m[2]]); if (+m[2] === 0) return _arrJoin(a); } } } return ''; };`,
    `const _fileSlot = (inc, key, params, fallback) => { if (inc != null && key in inc) return _incSlot(inc, key, params); return fallback(); };`,
    `const _wrapResource = (key, includes, slotParams, wrappers, resourceType, decorationTagName, cssClassName, decoration, decorations) => {`,
    `  const _slotFn = includes != null && typeof includes[key] === 'function' ? includes[key] : null;`,
    `  const _raw = _slotFn ? _slotFn(slotParams ?? {}) : null;`,
    `  const _rawClass = _raw != null && !Array.isArray(_raw) && typeof _raw === 'object' ? _raw._class : undefined;`,
    `  let r = _raw != null ? _arrJoin(_raw) : _incSlot(includes, key, slotParams);`,
    `  const cfg = wrappers?.[key] ?? (resourceType ? wrappers?.[resourceType] : undefined);`,
    `  const decCfg = decorations?.[key] ?? (resourceType ? decorations?.[resourceType] : undefined);`,
    `  const effectiveDecTag = decCfg?.decorationTagName ?? decorationTagName;`,
    `  const effectiveCssClass = [decCfg?.cssClassName, cssClassName].filter(Boolean).join(' ') || undefined;`,
    `  const effectiveDecoration = decCfg?.decoration !== undefined ? decCfg.decoration : decoration;`,
    `  if (cfg && typeof cfg === 'object' && cfg.childClass) {`,
    `    let d = 0, o = '', i = 0;`,
    `    while (i < r.length) {`,
    `      if (r[i] === '<') {`,
    `        const e = r.indexOf('>', i) + 1; const t = r.slice(i, e);`,
    `        if (t[1] === '/') { d--; o += t; }`,
    `        else {`,
    String.raw`          if (d === 0 && !t.startsWith('<!')) { o += /\bclass="/.test(t) ? t.replace(/class="([^"]*)"/, 'class="$1 ' + cfg.childClass + '"') : t.replace(/\/?>$/, ' class="' + cfg.childClass + '"$&'); }`,
    `          else { o += t; }`,
    `          if (!t.endsWith('/>')) d++;`,
    `        }`,
    `        i = e;`,
    `      } else { o += r[i++]; }`,
    `    }`,
    `    r = o;`,
    `  }`,
    `  if (_raw?._hasOwnDecoration) {`,
    `    const _inner = _raw._innerHtml != null ? _raw._innerHtml : r;`,
    `    const _ownDecTag = effectiveDecTag || 'div';`,
    `    if (_ownDecTag !== 'false' && effectiveDecoration !== false) {`,
    `      if (typeof cfg === 'string') r = '<' + _ownDecTag + ' class="' + cfg + '">' + r + '</' + _ownDecTag + '>';`,
    `      else if (cfg?.wrapper) r = '<' + _ownDecTag + ' class="' + cfg.wrapper + '">' + r + '</' + _ownDecTag + '>';`,
    `      else if (effectiveDecTag) { const _dc = [_rawClass, effectiveCssClass].filter(Boolean).join(' '); r = _dc ? '<' + _ownDecTag + ' class="' + _dc + '">' + _inner + '</' + _ownDecTag + '>' : '<' + _ownDecTag + '>' + _inner + '</' + _ownDecTag + '>'; }`,
    `      else r = _inner;`,
    `    }`,
    `    return r;`,
    `  }`,
    `  if (effectiveDecTag && effectiveDecTag !== 'false' && effectiveDecoration !== false) {`,
    `    const fnName = _slotFn ? _slotFn.name : '';`,
    `    const rawClass = _rawClass ?? (fnName.startsWith('create') ? fnName.slice(6).replace(/^(.)/, (_, c) => c.toLowerCase()) : '');`,
    `    const autoClass = resourceType ? resourceType.split('/').pop() ?? '' : rawClass;`,
    `    const wrapClass = typeof cfg === 'string' ? cfg : (cfg?.wrapper ?? autoClass);`,
    `    const finalClass = [wrapClass, effectiveCssClass].filter(Boolean).join(' ');`,
    `    r = finalClass ? '<' + effectiveDecTag + ' class="' + finalClass + '">' + r + '</' + effectiveDecTag + '>' : '<' + effectiveDecTag + '>' + r + '</' + effectiveDecTag + '>';`,
    `  }`,
    `  return r;`,
    `};`,
    '',
  ].join('\n');

  const resourceWrapperDecl = `const _staticResourceWrappers = ${JSON.stringify(resourceWrappers ?? {})};\n`;
  const resourceDecorationDecl = `const _staticResourceDecorations = ${JSON.stringify(resourceDecorations ?? {})};\n`;
  const finalBody = restoreVarCasing(body, restoreMap);

  // For ESM, hoist import declarations (emitted at the top of body) before helpers
  let esmImports = '';
  let codeBody = finalBody;
  if (format === 'esm') {
    const importLines: string[] = [];
    const restLines: string[] = [];
    for (const line of finalBody.split('\n')) {
      if (/^import\s/.test(line)) importLines.push(line);
      else restLines.push(line);
    }
    esmImports = importLines.length ? importLines.join('\n') + '\n\n' : '';
    codeBody = restLines.join('\n');
  }

  const slotsSet = new Set<string>();
  for (const m of codeBody.matchAll(SLOT_KEYS_RE)) {
    slotsSet.add(m[1] ?? m[2]);
  }
  const slotsLine = slotsSet.size
    ? format === 'esm'
      ? `\nexport const __slots__ = ${JSON.stringify([...slotsSet])};\n`
      : `\nconst __slots__ = ${JSON.stringify([...slotsSet])};\nObject.assign(module.exports, { __slots__ });\nfor (const _fn of Object.values(module.exports)) { if (typeof _fn === 'function') _fn.__slots__ = __slots__; }\n`
    : '';
  const sourceURLLine = emitSourceURL
    ? `\n//# sourceURL=${path.resolve(filename).replaceAll('\\', '/')}\n`
    : '';
  return (
    banner +
    esmImports +
    helpers +
    resourceWrapperDecl +
    resourceDecorationDecl +
    codeBody +
    slotsLine +
    sourceURLLine
  );
}

// ---------------------------------------------------------------------------
// Inline HTL transpilation for fileOverrides with htl content
// ---------------------------------------------------------------------------

function transpileInlineHtl(
  htlSource: string,
  omitAttrs: RegExp[],
  sourceDir: string,
  modelTransforms: Record<string, Record<string, ModelTransformValue>>,
  fileOverrides: Record<string, string>
): string {
  const expandedSource = htlSource.replaceAll(EXPAND_SLY_RE, '<sly$1></sly>');
  const { normalized, restoreMap } = normalizeSetVarCasing(expandedSource);
  const document = parseDocument(normalized);
  const originalTemplateNames = extractOriginalTemplateNames(normalized);
  const templates = findNamedTemplates(document, originalTemplateNames);

  if (templates.length === 0) {
    throw new Error(
      'fileOverrides htl content must contain data-sly-template definitions'
    );
  }

  const rawBody = transpileNamedTemplates(templates, omitAttrs, sourceDir, {
    modelTransforms,
    fileOverrides,
    includeDynamicUsePathDecl: false,
  });

  const declarations = restoreVarCasing(
    rawBody.replace(/\n\nmodule\.exports\s*=\s*\{[^}]*\};/, ''),
    restoreMap
  );

  const mapping = templates
    .map(({ name }) => `${name}: ${toPascalFnName('create', name)}`)
    .join(', ');

  return `(() => {\n${declarations}\nreturn { ${mapping} };\n})()`;
}

// ---------------------------------------------------------------------------
// Named template mode
// ---------------------------------------------------------------------------

function findNamedTemplates(
  document: any,
  originalNames: Record<string, string> = {}
): TemplateInfo[] {
  const templates: TemplateInfo[] = [];
  collectTemplates(document.children, templates, originalNames);
  return templates;
}

function collectTemplates(
  nodes: any[],
  acc: TemplateInfo[],
  originalNames: Record<string, string> = {}
): void {
  for (const node of nodes) {
    if (node.attribs) {
      const tmplKey = Object.keys(node.attribs).find((k) =>
        k.startsWith('data-sly-template.')
      );
      if (tmplKey) {
        const lowercasedName = tmplKey.replace('data-sly-template.', '');
        const name = originalNames[lowercasedName] || lowercasedName;
        const atMatch = node.attribs[tmplKey].match(/@\s*([\w,\s]+)/);
        const params = atMatch
          ? atMatch[1]
              .split(',')
              .map((s: string) => s.trim())
              .filter(Boolean)
          : [];
        acc.push({ name, params, node });
        continue;
      }
    }
    if (node.children) collectTemplates(node.children, acc, originalNames);
  }
}

interface InternalTranspileOpts {
  modelTransforms?: Record<string, Record<string, ModelTransformValue>>;
  wrapperClass?: string | boolean;
  fileOverrides?: Record<string, string>;
  i18nDefault?: string;
  format?: 'cjs' | 'esm';
  includeDynamicUsePathDecl?: boolean;
  usePathCaching?: boolean;
}

function transpileNamedTemplates(
  templates: TemplateInfo[],
  omitAttrs: RegExp[],
  sourceDir: string,
  {
    modelTransforms = {},
    fileOverrides = {},
    i18nDefault,
    format = 'cjs',
    includeDynamicUsePathDecl = true,
    usePathCaching = false,
  }: InternalTranspileOpts = {}
): string {
  const implicits = i18nDefault
    ? { ...AEM_IMPLICITS, _i18n: i18nDefault }
    : AEM_IMPLICITS;
  const localTemplates: Record<string, string> = Object.fromEntries(
    templates.map(({ name }) => [name, toPascalFnName('create', name)])
  );
  const fnNames: string[] = [];
  const esmImportLines: string[] = [];
  const parts = templates.map(({ name, params, node }) => {
    const ctx = createContext(omitAttrs, sourceDir, fileOverrides);
    Object.assign(ctx.localTemplates, localTemplates);
    for (const n of Object.keys(localTemplates)) ctx.definedVars.add(n);
    const templateDir = parseDirectives(node.attribs || {}, sourceDir);
    Object.assign(ctx.uses, templateDir.use);
    Object.assign(ctx.useDefaults, templateDir.useDefaults || {});
    Object.assign(ctx.fileUse, templateDir.fileUse);
    Object.assign(ctx.dynamicFileUse, templateDir.dynamicFileUse || {});
    const children = node.children || [];
    const body = walkNodes(children, ctx);
    const fnName = toPascalFnName('create', name);
    fnNames.push(fnName);
    const allParams = [...params];
    for (const useName of Object.keys(ctx.uses)) {
      if (!allParams.includes(useName)) allParams.push(useName);
    }
    for (const useName of Object.keys(ctx.jsFileUse)) {
      if (!allParams.includes(useName)) allParams.push(useName);
    }
    const setDecls = buildSetDecls(ctx.sets);
    for (const implicitName of Object.keys(implicits)) {
      if (
        !allParams.includes(implicitName) &&
        (body.includes(implicitName) || setDecls.includes(implicitName))
      ) {
        allParams.push(implicitName);
      }
    }
    addUseDefaultRefs(ctx.useDefaults, ctx.refs);
    const tempParams: ParamDecl[] = allParams.map((p) => ({
      name: p,
      default: '{}',
    }));
    addFreeVarParams(tempParams, ctx);
    for (const p of tempParams)
      if (!allParams.includes(p.name)) allParams.push(p.name);

    const jsUseBindings: Record<string, string> = {};
    if (format === 'esm') {
      for (const [useName, filePath] of Object.entries(ctx.jsFileUse)) {
        const { importDecl, constDecl, bindingName } = buildJsUseEsm(
          useName,
          filePath
        );
        if (!esmImportLines.includes(importDecl)) {
          esmImportLines.push(importDecl);
          if (constDecl) esmImportLines.push(constDecl);
        }
        jsUseBindings[useName] = bindingName;
      }
    }

    const paramStr = buildParamStr(
      allParams.map((p) => ({
        name: p,
        default:
          implicits[p] ??
          (ctx.jsFileUse[p]
            ? format === 'esm'
              ? (jsUseBindings[p] ?? buildJsUseDefault(ctx.jsFileUse[p]))
              : buildJsUseDefault(ctx.jsFileUse[p])
            : undefined) ??
          ctx.useDefaults[p] ??
          (params.includes(p) ? "''" : '{}'),
      }))
    );
    const transformDecls = buildModelTransformDecls(ctx.uses, modelTransforms);
    const contentIsEscapeHatch =
      ctx.refs.has('content') &&
      !('content' in ctx.uses) &&
      !('content' in ctx.jsFileUse) &&
      !ctx.definedVars.has('content');
    return buildFunctionBody(
      fnName,
      paramStr,
      setDecls,
      body,
      transformDecls,
      contentIsEscapeHatch,
      {
        _class: fnName.startsWith('create')
          ? fnName.slice(6).replace(/^(.)/, (_, c) => c.toLowerCase())
          : '',
        _resourceType: deriveResourceType(sourceDir),
      }
    );
  });
  const exportLine =
    format === 'esm'
      ? `export { ${fnNames.join(', ')} };`
      : `module.exports = { ${fnNames.join(', ')} };`;
  parts.push(exportLine);
  const prefix = esmImportLines.length ? esmImportLines.join('\n') + '\n' : '';
  const dynamicUsePathDecl = includeDynamicUsePathDecl
    ? buildDynamicUsePathDecl(sourceDir, usePathCaching)
    : '';
  return prefix + dynamicUsePathDecl + parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// Single template mode
// ---------------------------------------------------------------------------

function transpileSingleTemplate(
  document: any,
  filename: string,
  omitAttrs: RegExp[],
  sourceDir: string,
  {
    modelTransforms = {},
    wrapperClass,
    fileOverrides = {},
    i18nDefault,
    format = 'cjs',
    includeDynamicUsePathDecl = true,
    usePathCaching = false,
  }: InternalTranspileOpts = {}
): string {
  const implicits = i18nDefault
    ? { ...AEM_IMPLICITS, _i18n: i18nDefault }
    : AEM_IMPLICITS;
  const ctx = createContext(omitAttrs, sourceDir, fileOverrides);
  let body = walkNodes(document.children, ctx);
  const fnName = toPascalFnName('create', deriveBaseName(filename));

  const wrapperClassValue: string | false =
    wrapperClass === true
      ? path.basename(path.dirname(path.resolve(filename)))
      : typeof wrapperClass === 'string'
        ? wrapperClass
        : false;

  const params: ParamDecl[] = Object.keys(ctx.uses).map((name) => ({
    name,
    default: ctx.useDefaults[name] ?? '{}',
  }));

  const esmImportLines: string[] = [];
  const jsUseBindings: Record<string, string> = {};
  for (const [name, filePath] of Object.entries(ctx.jsFileUse)) {
    if (format === 'esm') {
      const { importDecl, constDecl, bindingName } = buildJsUseEsm(
        name,
        filePath
      );
      esmImportLines.push(importDecl);
      if (constDecl) esmImportLines.push(constDecl);
      jsUseBindings[name] = bindingName;
      params.push({ name, default: bindingName });
    } else {
      params.push({ name, default: buildJsUseDefault(filePath) });
    }
  }

  const setDecls = buildSetDecls(ctx.sets);

  for (const [name, defaultVal] of Object.entries(implicits)) {
    if (
      !ctx.uses[name] &&
      !ctx.jsFileUse[name] &&
      (body.includes(name) ||
        setDecls.includes(name) ||
        (name === '_wrapperClass' && !!wrapperClassValue))
    ) {
      params.push({ name, default: defaultVal });
    }
  }

  addUseDefaultRefs(ctx.useDefaults, ctx.refs);
  addFreeVarParams(params, ctx);

  const transformDecls = buildModelTransformDecls(ctx.uses, modelTransforms);
  const paramStr = buildParamStr(params);
  const contentIsEscapeHatch =
    ctx.refs.has('content') &&
    !('content' in ctx.uses) &&
    !('content' in ctx.jsFileUse) &&
    !ctx.definedVars.has('content');
  const exportLine =
    format === 'esm'
      ? `\nexport { ${fnName} };`
      : `\nmodule.exports = { ${fnName} };`;
  const prefix = esmImportLines.length ? esmImportLines.join('\n') + '\n' : '';
  const dynamicUsePathDecl = includeDynamicUsePathDecl
    ? buildDynamicUsePathDecl(sourceDir, usePathCaching)
    : '';
  return (
    prefix +
    dynamicUsePathDecl +
    buildFunctionBody(
      fnName,
      paramStr,
      setDecls,
      body,
      transformDecls,
      contentIsEscapeHatch,
      {
        _class: deriveBaseName(filename),
        _resourceType: deriveResourceType(sourceDir),
        _wrapperClass: wrapperClassValue,
      }
    ) +
    exportLine
  );
}

function buildJsUseDefault(filePath: string): string {
  if (filePath.endsWith('.json')) {
    return `require('${filePath}')`;
  }
  return `(() => { const _m = require('${filePath}'); return typeof _m === 'function' ? _m({}) : _m; })()`;
}

function buildJsUseEsm(
  varName: string,
  filePath: string
): { importDecl: string; constDecl: string | null; bindingName: string } {
  const bindingName = `_jsuse_${varName}`;
  if (filePath.endsWith('.json')) {
    return {
      importDecl: `import ${bindingName} from '${filePath}';`,
      constDecl: null,
      bindingName,
    };
  }
  const rawName = `${bindingName}_raw`;
  return {
    importDecl: `import ${rawName} from '${filePath}';`,
    constDecl: `const ${bindingName} = typeof ${rawName} === 'function' ? ${rawName}({}) : ${rawName};`,
    bindingName,
  };
}

function findContentSlot(body: string): string | null {
  const slots: string[] = [];
  for (const m of body.matchAll(RESOURCE_SLOT_KEYS_RE)) {
    slots.push(m[1]);
  }
  const found = slots.find((s) => PARSYS_SLOTS.has(s)) ?? slots[0] ?? null;
  if (!found) return null;
  // Strip _N suffix so content arrays distribute across par_0, par_1, etc.
  const baseMatch = /^(.+)_\d+$/.exec(found);
  return baseMatch ? baseMatch[1] : found;
}

function buildFunctionBody(
  fnName: string,
  paramStr: string,
  setDecls: string,
  body: string,
  transformDecls = '',
  contentParamIsEscapeHatch = false,
  meta: {
    _class: string;
    _resourceType: string | null;
    _wrapperClass?: string | false;
  } = DEFAULT_FUNCTION_META
): string {
  const lines = [`const ${fnName} = (${paramStr}) => {`];
  if (paramStr.includes('_includes')) {
    const slot = findContentSlot(body);
    const hasContentParam = contentParamIsEscapeHatch;
    const contentSource = hasContentParam
      ? '(typeof content === "function" || Array.isArray(content) || (content != null && typeof content === "object" && Object.keys(content).length > 0)) ? content : _rest.content'
      : '_rest.content';
    const hasModelParam = /\bmodel\s*=/.test(paramStr);
    const contentCallArg = hasModelParam ? '{ model, ..._rest }' : '_rest';
    lines.push(
      `  const _contentArg = ${contentSource};`,
      '  if (_contentArg != null) {',
      `    const _contentValue = typeof _contentArg === 'function' ? _contentArg(${contentCallArg}) : _contentArg;`,
      `    if (_contentValue != null && typeof _contentValue === 'object' && !Array.isArray(_contentValue) && _contentValue.toString === Object.prototype.toString) {`,
      '      _includes = Object.assign(_contentValue, _includes);',
      `    }${slot ? ' else {' : ''}`
    );
    if (slot) {
      lines.push(
        `      _includes = Object.assign({ '${slot}': _contentValue }, _includes);`,
        '    }'
      );
    }
    lines.push('  }');
  }
  if (transformDecls) lines.push(transformDecls);
  if (setDecls) lines.push(setDecls);
  if (meta._wrapperClass) {
    lines.push(
      `  const _html = /* html */\`${body.trim()}\`;`,
      `  const _wrapClass = \`${meta._wrapperClass}\${_wrapperClass ? ' ' + _wrapperClass : ''}\`;`,
      `  return { toString: () => \`<div class="\${_wrapClass}">\${_html}</div>\`, _class: ${JSON.stringify(meta._class)}, _resourceType: ${JSON.stringify(meta._resourceType)}, _slots: typeof __slots__ !== 'undefined' ? __slots__ : undefined, _hasOwnDecoration: true, _innerHtml: _html, _decorationTagName: undefined, _attrs: {} };`,
      '};'
    );
  } else {
    lines.push(
      `  const _html = /* html */\`${body.trim()}\`;`,
      `  return { toString: () => _html, _class: ${JSON.stringify(meta._class)}, _resourceType: ${JSON.stringify(meta._resourceType)}, _slots: typeof __slots__ !== 'undefined' ? __slots__ : undefined, _hasOwnDecoration: false, _decorationTagName: undefined, _attrs: {} };`,
      '};'
    );
  }
  return lines.join('\n');
}

function deriveResourceType(sourceDir: string): string | null {
  if (!sourceDir) return null;
  const jcrRoot = findNearestJcrRoot(sourceDir);
  if (!jcrRoot) return null;
  const rel = path
    .relative(jcrRoot, path.resolve(sourceDir))
    .replaceAll('\\', '/');
  const parts = rel.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  return parts.slice(1).join('/'); // strip 'apps' / 'libs' prefix
}

function findNearestJcrRoot(startDir: string): string | null {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, 'jcr_root');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function collectFiles(rootDir: string, allowedExts: Set<string>): string[] {
  const results: string[] = [];
  const stack = [rootDir];
  while (stack.length) {
    const current = stack.pop() as string;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (allowedExts.has(path.extname(entry.name))) results.push(fullPath);
    }
  }
  return results;
}

const _dynamicUsePathCache = new Map<string, Record<string, string>>();

function buildDynamicUsePathMap(
  sourceDir: string,
  useCache: boolean
): Record<string, string> {
  const rootDir = findNearestJcrRoot(sourceDir) ?? path.resolve(sourceDir);

  if (useCache) {
    const cached = _dynamicUsePathCache.get(rootDir);
    if (cached) return cached;
  }

  const map: Record<string, string> = {};
  const sourceRoot = path.resolve(sourceDir);
  const files = collectFiles(rootDir, new Set(['.html', '.js', '.json']));

  for (const filePath of files) {
    const relToSource = path
      .relative(sourceRoot, filePath)
      .replaceAll('\\', '/');
    const requirePath = relToSource.startsWith('.')
      ? relToSource
      : `./${relToSource}`;
    map[requirePath] = requirePath;
    if (requirePath.startsWith('./')) map[requirePath.slice(2)] = requirePath;

    if (rootDir.endsWith('jcr_root')) {
      const relToJcrRoot = path
        .relative(rootDir, filePath)
        .replaceAll('\\', '/');
      map[`/${relToJcrRoot}`] = requirePath;
    }
  }

  if (useCache) _dynamicUsePathCache.set(rootDir, map);
  return map;
}

function buildDynamicUsePathDecl(sourceDir: string, useCache: boolean): string {
  if (!fs.existsSync(sourceDir)) return '';
  const map = buildDynamicUsePathMap(sourceDir, useCache);
  const keys = Object.keys(map);
  if (!keys.length) return '';
  return [
    `const __resolveUsePathMap = ${JSON.stringify(map)};`,
    `const __resolveUsePath = (value) => __resolveUsePathMap[String(value ?? '')] ?? String(value ?? '');`,
    '',
  ].join('\n');
}

function addUseDefaultRefs(
  useDefaults: Record<string, string>,
  refs: Set<string>
): void {
  for (const expr of Object.values(useDefaults)) {
    if (!expr) continue;
    if (String(expr).trimStart().startsWith('(()')) continue;
    const stripped = String(expr)
      .replaceAll(/'[^']*'/g, '')
      .replaceAll(/"[^"]*"/g, '');
    for (const m of stripped.matchAll(
      /(?<![?.])\b([a-zA-Z_$][a-zA-Z0-9_$]*)\b/g
    )) {
      if (
        stripped[m.index + m[0].length] === '$' &&
        stripped[m.index + m[0].length + 1] === '{'
      ) {
        continue;
      }
      refs.add(m[1]);
    }
  }
}

function classKeyMatchesUseVal(classKey: string, useVal: string): boolean {
  return useVal === classKey || useVal.endsWith('.' + classKey);
}

/**
 * Builds assignment lines that merge computed properties into model variables,
 * based on modelTransforms config.
 */
function buildModelTransformDecls(
  uses: Record<string, string>,
  modelTransforms: Record<string, Record<string, ModelTransformValue>>
): string {
  if (!Object.keys(modelTransforms).length) return '';
  const scopeVars = Object.keys(uses);
  const lines: string[] = [];
  for (const [varName, useVal] of Object.entries(uses)) {
    for (const [classKey, props] of Object.entries(modelTransforms)) {
      if (classKeyMatchesUseVal(classKey, String(useVal))) {
        const resolve = (v: ModelTransformValue) =>
          resolveModelTransformValue(v, varName, scopeVars);
        const modelEntries = Object.entries(props).filter(
          ([k]) => !k.startsWith('_')
        );
        if (modelEntries.length) {
          const propsStr = modelEntries
            .map(([k, v]) => `${k}: ${resolve(v)}`)
            .join(', ');
          lines.push(
            `  ${varName} = Object.assign({ ${propsStr} }, ${varName});`
          );
        }
        if (props._includes != null) {
          lines.push(
            `  _includes = Object.assign(${resolve(props._includes)}, _includes);`
          );
        }
      }
    }
  }
  return lines.join('\n');
}

function resolveModelTransformValue(
  value: ModelTransformValue,
  varName: string,
  scopeVars: string[] = []
): string {
  if (typeof value !== 'function') {
    return String(value).replaceAll(/\bmodel\b/g, varName);
  }

  const directExpr = serializeDirectModelTransform(value, varName, scopeVars);

  if (value.length === 0) {
    try {
      const legacyResult = (value as () => unknown)();
      if (
        typeof legacyResult === 'string' &&
        shouldTreatZeroArgStringResultAsLegacy(legacyResult)
      ) {
        return legacyResult.replaceAll(/\bmodel\b/g, varName);
      }
    } catch {
      // Fall through to direct-code serialization.
    }
  }

  if (directExpr != null) return directExpr;

  const legacyResult = (value as LegacyModelTransformFn)(varName);
  if (typeof legacyResult !== 'string') {
    throw new TypeError(
      `[htl-to-js] modelTransforms value for "${varName}" is not serializable. ` +
        `Use a string expression or a function with recognized bindings: model, _includes, varName, or "${varName}".`
    );
  }
  return legacyResult;
}

function shouldTreatZeroArgStringResultAsLegacy(result: string): boolean {
  const trimmed = result.trim();
  if (!trimmed) return false;

  if (/^(['"`]).*\1$/s.test(trimmed)) return true;

  return /[()[\]{}?.:+\-*/%<>=&|!,]/.test(trimmed);
}

function serializeDirectModelTransform(
  value: Function,
  varName: string,
  scopeVars: string[] = []
): string | null {
  const parsed = parseDirectTransformSource(value);
  if (!parsed) return null;

  const bindings = parseDirectTransformBindings(
    parsed.params,
    varName,
    scopeVars
  );
  if (!bindings) return null;

  const expression = parsed.isBlock
    ? `(() => {\n${parsed.body}\n})()`
    : parsed.body;

  return replaceDirectTransformBindings(expression, bindings);
}

function parseDirectTransformSource(
  value: Function
): { params: string; body: string; isBlock: boolean } | null {
  const source = Function.prototype.toString.call(value).trim();

  const emptyArrowMatch = /^\(\s*\)\s*=>\s*([\s\S]*)$/.exec(source);
  if (emptyArrowMatch) {
    const rawBody = emptyArrowMatch[1].trim();
    if (rawBody.startsWith('{') && rawBody.endsWith('}')) {
      return {
        params: '',
        body: rawBody.slice(1, -1).trim(),
        isBlock: true,
      };
    }
    return {
      params: '',
      body: rawBody,
      isBlock: false,
    };
  }

  const arrowMatch = /^\(\s*\{([\s\S]*?)\}\s*\)\s*=>\s*([\s\S]*)$/.exec(source);
  if (arrowMatch) {
    const rawBody = arrowMatch[2].trim();
    if (rawBody.startsWith('{') && rawBody.endsWith('}')) {
      return {
        params: arrowMatch[1],
        body: rawBody.slice(1, -1).trim(),
        isBlock: true,
      };
    }
    return {
      params: arrowMatch[1],
      body: rawBody,
      isBlock: false,
    };
  }

  const fnMatch =
    /^function\b[^()]*(?:\([^)]*\))?\s*\(\s*\{([\s\S]*?)\}\s*\)\s*\{([\s\S]*)\}$/.exec(
      source
    );
  if (fnMatch) {
    return {
      params: fnMatch[1],
      body: fnMatch[2].trim(),
      isBlock: true,
    };
  }

  return null;
}

function parseDirectTransformBindings(
  paramsSource: string,
  varName: string,
  scopeVars: string[] = []
): Map<string, string> | null {
  const bindings = new Map<string, string>();
  const entries = paramsSource
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  for (const entry of entries) {
    const aliasMatch =
      /^(model|_includes|varName|content)\s*:\s*([A-Za-z_$][\w$]*)$/.exec(
        entry
      );
    if (aliasMatch) {
      bindings.set(
        aliasMatch[2],
        resolveDirectBindingValue(aliasMatch[1], varName)
      );
      continue;
    }

    if (/^(model|_includes|varName|content)$/.test(entry)) {
      bindings.set(entry, resolveDirectBindingValue(entry, varName));
      continue;
    }

    // Accept the varName itself as a binding (e.g. ({ tabs }) when varName='tabs').
    if (entry === varName) {
      bindings.set(entry, varName);
      continue;
    }

    // Accept an alias of varName (e.g. ({ tabs: t }) when varName='tabs').
    const varNameAliasMatch = /^(\w+)\s*:\s*([A-Za-z_$][\w$]*)$/.exec(entry);
    if (varNameAliasMatch?.[1] === varName) {
      bindings.set(varNameAliasMatch[2], varName);
      continue;
    }

    // Accept any other use var already in scope in this file (e.g. ({ carousel })
    // when the transform's own varName is 'styleModel' but 'carousel' is another
    // use var declared in the same template).
    if (scopeVars.includes(entry)) {
      bindings.set(entry, entry);
      continue;
    }

    // Accept an alias of another in-scope use var (e.g. ({ carousel: c })).
    if (varNameAliasMatch && scopeVars.includes(varNameAliasMatch[1])) {
      bindings.set(varNameAliasMatch[2], varNameAliasMatch[1]);
      continue;
    }

    // Any other plain identifier is treated as a _rest binding (e.g. ({ fragment }) → _rest.fragment).
    if (/^[A-Za-z_$][\w$]*$/.test(entry)) {
      bindings.set(entry, `_rest.${entry}`);
      continue;
    }

    // Any other aliased identifier is treated as a _rest binding (e.g. ({ fragment: frag }) → _rest.fragment).
    const restAliasMatch = /^([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)$/.exec(
      entry
    );
    if (restAliasMatch) {
      bindings.set(restAliasMatch[2], `_rest.${restAliasMatch[1]}`);
      continue;
    }

    return null;
  }

  return bindings;
}

function resolveDirectBindingValue(
  bindingName: string,
  varName: string
): string {
  if (bindingName === 'model') return varName;
  if (bindingName === '_includes') return '_includes';
  if (bindingName === 'content')
    return '(typeof content === "function" ? content : _rest.content)';
  return JSON.stringify(varName);
}

function replaceDirectTransformBindings(
  expression: string,
  bindings: Map<string, string>
): string {
  let output = expression;
  for (const [localName, replacement] of bindings) {
    if (localName === replacement) continue;
    output = output.replace(
      new RegExp(
        String.raw`(?<=[{,]\s*)${escapeRegExp(localName)}(?=\s*[,}])`,
        'g'
      ),
      `${localName}: ${replacement}`
    );
    output = output.replace(
      new RegExp(
        String.raw`(?<key>(?<=[{,]\s*)${escapeRegExp(localName)}(?=\s*:))|(?<ref>(?<!\.)\b${escapeRegExp(localName)}\b)`,
        'g'
      ),
      (match, key) => (key === undefined ? replacement : match)
    );
  }
  return output;
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function extractOriginalTemplateNames(source: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const m of source.matchAll(/data-sly-template\.([A-Za-z_]\w*)/g)) {
    map[m[1].toLowerCase()] = m[1];
  }
  return map;
}

export function generateDts(jsSource: string): string {
  const lines: string[] = [];
  const slotsMatch = /const __slots__ = (\[[^\]]*\])/.exec(jsSource);
  const slots: string[] = slotsMatch ? JSON.parse(slotsMatch[1]) : [];
  // Only named resource slots (no file paths) get specific typed properties.
  // File-path keys from data-sly-include/call remain overridable at runtime
  // but don't appear as named TypeScript properties — they'd be confusing and
  // are already covered by the index signature.
  const namedSlots = slots.filter((s) => !/[/\\]|\.html$|\.js$/.test(s));
  for (const m of jsSource.matchAll(
    /const (create\w+) = \(\{((?:[^{}]|\{[^}]*\})*)\}\s*=\s*\{\}\)/g
  )) {
    const fnName = m[1];
    const paramBlock = m[2];
    const paramNames = paramBlock
      .split(',')
      .map((p) => p.replace(/\s*=[\s\S]*/g, '').trim())
      .filter((p) => /^\w+$/.test(p));
    const slopMapper = namedSlots
      .map((s) => `'${s}'?: string | (() => string)`)
      .join('; ');
    const incType =
      namedSlots.length > 0
        ? `{ ${slopMapper}; [key: string]: string | (() => string) | undefined }`
        : `Record<string, string | (() => string) | undefined>`;
    const propList = paramNames
      .map((p) => (p === '_includes' ? `${p}?: ${incType}` : `${p}?: any`))
      .join('; ');
    const propsType = paramNames.length
      ? `{ ${propList} }`
      : 'Record<string, any>';
    const returnType = [
      '{ toString(): string',
      '_class: string',
      '_resourceType: string | null',
      '_slots: string[] | undefined',
      '_hasOwnDecoration: boolean',
      '_decorationTagName: string | undefined',
      '_attrs: Record<string, unknown>',
      '}',
    ].join('; ');
    lines.push(
      `export declare function ${fnName}(args?: ${propsType}): ${returnType};`
    );
  }
  if (slotsMatch && namedSlots.length > 0) {
    lines.push(
      `export declare const __slots__: ${JSON.stringify(namedSlots).replace(/"/g, "'")};`
    );
  }
  return lines.join('\n') + '\n';
}

const JS_RESERVED = new Set(['class', 'for']);

const JS_BUILTINS = new Set([
  'true',
  'false',
  'null',
  'undefined',
  'NaN',
  'Infinity',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'this',
  'super',
  'class',
  'const',
  'let',
  'var',
  'function',
  'return',
  'if',
  'else',
  'for',
  'while',
  'do',
  'switch',
  'case',
  'break',
  'continue',
  'default',
  'throw',
  'try',
  'catch',
  'finally',
  'import',
  'export',
  'async',
  'await',
  'yield',
  'static',
  'with',
  'Math',
  'JSON',
  'Array',
  'Object',
  'String',
  'Number',
  'Boolean',
  'Date',
  'require',
  'module',
  'console',
  'parseInt',
  'parseFloat',
]);

/**
 * Scans ctx.refs for variable names that are referenced but not declared
 * anywhere (not in params, AEM implicits, defined vars, or fileUse),
 * and adds them as params with default `{}`.
 */
function addFreeVarParams(params: ParamDecl[], ctx: WalkerContext): void {
  const known = new Set([
    ...params.map((p) => p.name),
    ...Object.keys(AEM_IMPLICITS),
    ...Object.keys(ctx.fileUse || {}),
    ...Object.keys(ctx.jsFileUse || {}),
    ...(ctx.definedVars || []),
  ]);
  for (const ref of ctx.refs || []) {
    if (JS_BUILTINS.has(ref) || known.has(ref) || ref.startsWith('_')) continue;
    params.push({ name: ref, default: '{}' });
    known.add(ref);
  }
}

function buildParamStr(params: ParamDecl[]): string {
  if (!params.length) return `{ ..._rest } = {}`;
  const inner = params
    .map((p) => {
      const safe = JS_RESERVED.has(p.name) ? `_${p.name}` : p.name;
      return safe === p.name
        ? `${p.name} = ${p.default}`
        : `${p.name}: ${safe} = ${p.default}`;
    })
    .join(', ');
  return `{ ${inner}, ..._rest } = {}`;
}

function buildSetDecls(sets: SetDecl[]): string {
  if (!sets.length) return '';
  const seen = new Set<string>();
  return sets
    .filter((s) => {
      if (seen.has(s.name)) return false;
      seen.add(s.name);
      return true;
    })
    .map((s) => {
      const safe = JS_RESERVED.has(s.name) ? `_${s.name}` : s.name;
      return s.raw
        ? `  const ${safe} = ${s.expr};`
        : `  const ${safe} = \`${s.expr}\`;`;
    })
    .join('\n');
}

function deriveBaseName(filename: string): string {
  return path.basename(filename, path.extname(filename));
}

function toPascalFnName(prefix: string, name: string): string {
  const pascal = name
    .replaceAll(/[-_](\w)/g, (_: string, c: string) => c.toUpperCase())
    .replace(/^\w/, (c) => c.toUpperCase());
  return prefix + pascal;
}

function normalizeSetVarCasing(source: string): {
  normalized: string;
  restoreMap: Record<string, string>;
} {
  const restoreMap: Record<string, string> = {};

  const DIRECTIVES = [
    'data-sly-set',
    'data-sly-use',
    'data-sly-repeat',
    'data-sly-list',
    'data-sly-test',
  ];
  for (const dir of DIRECTIVES) {
    for (const m of source.matchAll(
      new RegExp(String.raw`${dir}\.([A-Za-z_]\w*)`, 'g')
    )) {
      if (m[1] !== m[1].toLowerCase()) {
        restoreMap[m[1].toLowerCase()] = m[1];
        if (dir === 'data-sly-list' || dir === 'data-sly-repeat') {
          restoreMap[m[1].toLowerCase() + 'List'] = m[1] + 'List';
        }
      }
    }
  }

  if (!Object.keys(restoreMap).length)
    return { normalized: source, restoreMap };

  const directivesPattern = DIRECTIVES.map((d) =>
    d.replaceAll('-', String.raw`\-`)
  ).join('|');
  let result = source;
  for (const [lower, name] of Object.entries(restoreMap)) {
    result = result.replaceAll(
      new RegExp(String.raw`((?:${directivesPattern})\.)${name}\b`, 'g'),
      `$1${lower}`
    );
    const varRe = new RegExp(String.raw`(?<!\.)\b${name}\b`, 'g');
    let rebuilt = '';
    let lastEnd = 0;
    for (const { index, expr, end } of extractExprs(result)) {
      rebuilt += result.slice(lastEnd, index + 2); // literal before + '${'
      rebuilt += expr.replace(varRe, lower);
      rebuilt += '}';
      lastEnd = end;
    }
    result = rebuilt + result.slice(lastEnd);
  }
  return { normalized: result, restoreMap };
}

function restoreVarCasing(
  js: string,
  restoreMap: Record<string, string>
): string {
  if (!Object.keys(restoreMap).length) return js;
  let result = js;
  for (const [lower, original] of Object.entries(restoreMap)) {
    result = result.replaceAll(
      new RegExp(String.raw`(?<!\.)\b${lower}\b`, 'g'),
      original
    );
  }
  return result;
}
