import { parseDocument } from 'htmlparser2';
import { createContext, walkNodes } from './walker';
import type { WalkerContext } from './walker';
import type { SetDecl } from './directives';
import { parseDirectives } from './directives';
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
  request:
    "{ requestPathInfo: { selectorString: '', suffix: '', resourcePath: ''  }, contextPath: ''  }",
};

interface TranspileOptions {
  filename?: string;
  omitAttrs?: RegExp[];
  i18nDict?: Record<string, string>;
  modelTransforms?: Record<string, Record<string, string | ((varName: string) => string)>>;
  wrapperClass?: string | boolean;
  resourceWrappers?: Record<
    string,
    string | { wrapper?: string; childClass?: string }
  >;
  fileOverrides?: Record<
    string,
    string | { expression?: string; htl?: string }
  >;
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
    modelTransforms = {},
    wrapperClass,
    resourceWrappers,
    fileOverrides = {},
  }: TranspileOptions = {}
): string {
  const expandedSource = htlSource.replaceAll(
    /<sly\b([^>]*?)\/>/g,
    '<sly$1></sly>'
  );
  const { normalized: normalizedSource, restoreMap } =
    normalizeSetVarCasing(expandedSource);
  const document = parseDocument(normalizedSource);

  const originalTemplateNames = extractOriginalTemplateNames(normalizedSource);
  const templates = findNamedTemplates(document, originalTemplateNames);

  const sourceDir = path.dirname(path.resolve(filename));

  const serializedFileOverrides: Record<string, string> = {};
  const inlinedDeclarations: string[] = [];
  for (const [key, val] of Object.entries(fileOverrides)) {
    if (typeof val === 'string') {
      serializedFileOverrides[key] = val;
    } else if (val.htl) {
      const { declarations, expression } = transpileInlineHtl(
        val.htl, omitAttrs, sourceDir, modelTransforms,
        serializedFileOverrides,
      );
      inlinedDeclarations.push(declarations);
      serializedFileOverrides[key] = expression;
    } else if (val.expression) {
      serializedFileOverrides[key] = val.expression;
    }
  }

  const i18nDefault = i18nDict ? JSON.stringify(i18nDict) : undefined;

  let body: string;
  if (templates.length > 0) {
    body = transpileNamedTemplates(
      templates,
      omitAttrs,
      sourceDir,
      modelTransforms,
      serializedFileOverrides,
      i18nDefault,
    );
  } else {
    body = transpileSingleTemplate(
      document,
      filename,
      omitAttrs,
      sourceDir,
      modelTransforms,
      wrapperClass,
      serializedFileOverrides,
      i18nDefault,
    );
  }

  const banner = `// AUTO-GENERATED from ${path.basename(filename)} — DO NOT EDIT\n\n`;
  const helpers = [
    `const _htlAttr = (v) => v == null ? '' : (typeof v === 'object' ? JSON.stringify(v).replace(/"/g, '&quot;') : String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'));`,
    `const _htlDynAttr = (name, val) => { if (val == null || val === false) return ''; if (val === true) return ' ' + name; return ' ' + name + '="' + _htlAttr(val) + '"'; };`,
    `const _htlSpreadAttrs = (obj) => { if (!obj || typeof obj !== 'object') return ''; return Object.entries(obj).map(([k, v]) => _htlDynAttr(k, v)).join(''); };`,
    `const _inc = (v) => typeof v === 'function' ? v() : String(v ?? '');`,
    `const _wrapResource = (key, html, wrappers, resourceType) => {`,
    `  const cfg = wrappers?.[key] ?? (resourceType ? wrappers?.[resourceType] : undefined); if (!cfg) return html;`,
    `  if (typeof cfg === 'string') return '<div class="' + cfg + '">' + html + '</div>';`,
    `  let r = html;`,
    `  if (cfg.childClass) {`,
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
    `  if (cfg.wrapper) r = '<div class="' + cfg.wrapper + '">' + r + '</div>';`,
    `  return r;`,
    `};`,
    '',
  ].join('\n');

  const resourceWrapperDecl = `const _staticResourceWrappers = ${JSON.stringify(resourceWrappers ?? {})};\n`;
  const inlinedCode = inlinedDeclarations.length
    ? inlinedDeclarations.join('\n\n') + '\n\n'
    : '';
  const finalBody = restoreVarCasing(body, restoreMap);
  const slotsSet = new Set<string>();
  for (const m of finalBody.matchAll(/_inc\(_includes\?\.\['([^']+)'\]\)/g)) {
    slotsSet.add(m[1]);
  }
  const slotsLine = slotsSet.size
    ? `\nObject.assign(module.exports, { __slots__: ${JSON.stringify([...slotsSet])} });\n`
    : '';
  return (
    banner + helpers + resourceWrapperDecl + inlinedCode + finalBody + slotsLine
  );
}

// ---------------------------------------------------------------------------
// Inline HTL transpilation for fileOverrides with htl content
// ---------------------------------------------------------------------------

function transpileInlineHtl(
  htlSource: string,
  omitAttrs: RegExp[],
  sourceDir: string,
  modelTransforms: Record<string, Record<string, string | ((varName: string) => string)>>,
  fileOverrides: Record<string, string>,
): { declarations: string; expression: string } {
  const expandedSource = htlSource.replaceAll(
    /<sly\b([^>]*?)\/>/g,
    '<sly$1></sly>'
  );
  const { normalized, restoreMap } = normalizeSetVarCasing(expandedSource);
  const document = parseDocument(normalized);
  const originalTemplateNames = extractOriginalTemplateNames(normalized);
  const templates = findNamedTemplates(document, originalTemplateNames);

  if (templates.length === 0) {
    throw new Error(
      'fileOverrides htl content must contain data-sly-template definitions'
    );
  }

  const rawBody = transpileNamedTemplates(
    templates,
    omitAttrs,
    sourceDir,
    modelTransforms,
    fileOverrides,
  );

  const declarations = restoreVarCasing(
    rawBody.replace(/\n\nmodule\.exports\s*=\s*\{[^}]*\};/, ''),
    restoreMap,
  );

  const mapping = templates
    .map(({ name }) => `${name}: ${toPascalFnName('create', name)}`)
    .join(', ');

  return { declarations, expression: `{ ${mapping} }` };
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

function transpileNamedTemplates(
  templates: TemplateInfo[],
  omitAttrs: RegExp[],
  sourceDir: string,
  modelTransforms: Record<string, Record<string, string | ((varName: string) => string)>> = {},
  fileOverrides: Record<string, string> = {},
  i18nDefault?: string,
): string {
  const implicits = i18nDefault ? { ...AEM_IMPLICITS, _i18n: i18nDefault } : AEM_IMPLICITS;
  const localTemplates: Record<string, string> = Object.fromEntries(
    templates.map(({ name }) => [name, toPascalFnName('create', name)])
  );
  const fnNames: string[] = [];
  const parts = templates.map(({ name, params, node }) => {
    const ctx = createContext(
      omitAttrs,
      sourceDir,
      fileOverrides,
    );
    Object.assign(ctx.localTemplates, localTemplates);
    for (const n of Object.keys(localTemplates)) ctx.definedVars.add(n);
    const templateDir = parseDirectives(node.attribs || {}, sourceDir);
    Object.assign(ctx.uses, templateDir.use);
    Object.assign(ctx.useDefaults, templateDir.useDefaults || {});
    Object.assign(ctx.fileUse, templateDir.fileUse);
    const children = node.children || [];
    const body = walkNodes(children, ctx);
    const fnName = toPascalFnName('create', name);
    fnNames.push(fnName);
    const allParams = [...params];
    for (const useName of Object.keys(ctx.uses)) {
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
    const tempParams: ParamDecl[] = allParams.map((p) => ({
      name: p,
      default: '{}',
    }));
    addFreeVarParams(tempParams, ctx);
    for (const p of tempParams)
      if (!allParams.includes(p.name)) allParams.push(p.name);
    const paramStr = buildParamStr(
      allParams.map((p) => ({
        name: p,
        default:
          implicits[p] ??
          ctx.useDefaults[p] ??
          (params.includes(p) ? "''" : '{}'),
      }))
    );
    const transformDecls = buildModelTransformDecls(ctx.uses, modelTransforms);
    return buildFunctionBody(fnName, paramStr, setDecls, body, transformDecls);
  });
  parts.push(`module.exports = { ${fnNames.join(', ')} };`);
  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// Single template mode
// ---------------------------------------------------------------------------

function transpileSingleTemplate(
  document: any,
  filename: string,
  omitAttrs: RegExp[],
  sourceDir: string,
  modelTransforms: Record<string, Record<string, string | ((varName: string) => string)>> = {},
  wrapperClass?: string | boolean,
  fileOverrides: Record<string, string> = {},
  i18nDefault?: string,
): string {
  const implicits = i18nDefault ? { ...AEM_IMPLICITS, _i18n: i18nDefault } : AEM_IMPLICITS;
  const ctx = createContext(
    omitAttrs,
    sourceDir,
    fileOverrides,
  );
  let body = walkNodes(document.children, ctx);
  const fnName = toPascalFnName('create', deriveBaseName(filename));

  if (wrapperClass === true) {
    const folderName = path.basename(path.dirname(path.resolve(filename)));
    body = `<div class="${folderName}\${_wrapperClass ? ' ' + _wrapperClass : ''}">${body.trim()}</div>`;
  } else if (typeof wrapperClass === 'string') {
    body = `<div class="${wrapperClass}\${_wrapperClass ? ' ' + _wrapperClass : ''}">${body.trim()}</div>`;
  }

  const params: ParamDecl[] = Object.keys(ctx.uses).map((name) => ({
    name,
    default: ctx.useDefaults[name] ?? '{}',
  }));
  const setDecls = buildSetDecls(ctx.sets);

  for (const [name, defaultVal] of Object.entries(implicits)) {
    if (!ctx.uses[name] && (body.includes(name) || setDecls.includes(name))) {
      params.push({ name, default: defaultVal });
    }
  }

  addFreeVarParams(params, ctx);

  const transformDecls = buildModelTransformDecls(ctx.uses, modelTransforms);
  const paramStr = buildParamStr(params);
  return (
    buildFunctionBody(fnName, paramStr, setDecls, body, transformDecls) +
    `\nmodule.exports = { ${fnName} };`
  );
}

// ---------------------------------------------------------------------------
// Code generation helpers
// ---------------------------------------------------------------------------

function buildFunctionBody(
  fnName: string,
  paramStr: string,
  setDecls: string,
  body: string,
  transformDecls = ''
): string {
  const lines = [`const ${fnName} = (${paramStr}) => {`];
  if (transformDecls) lines.push(transformDecls);
  if (setDecls) lines.push(setDecls);
  lines.push(`  return /* html */\`${body.trim()}\`;`, '};');
  return lines.join('\n');
}

/**
 * Builds assignment lines that merge computed properties into model variables,
 * based on modelTransforms config.
 */
function buildModelTransformDecls(
  uses: Record<string, string>,
  modelTransforms: Record<string, Record<string, string | ((varName: string) => string)>>
): string {
  if (!Object.keys(modelTransforms).length) return '';
  const lines: string[] = [];
  for (const [varName, useVal] of Object.entries(uses)) {
    for (const [classKey, props] of Object.entries(modelTransforms)) {
      if (String(useVal).includes(classKey)) {
        const resolve = (v: string | ((n: string) => string)) =>
          typeof v === 'function' ? v(varName) : String(v).replaceAll(/\bmodel\b/g, varName);
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

function extractOriginalTemplateNames(source: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const m of source.matchAll(/data-sly-template\.([A-Za-z_]\w*)/g)) {
    map[m[1].toLowerCase()] = m[1];
  }
  return map;
}

export function generateDts(jsSource: string): string {
  const lines: string[] = [];
  for (const m of jsSource.matchAll(/const (create\w+) = \(\{((?:[^{}]|\{[^}]*\})*)\}\s*=\s*\{\}\)/g)) {
    const fnName = m[1];
    const paramBlock = m[2];
    const paramNames = paramBlock
      .split(',')
      .map((p) => p.replace(/\s*=[\s\S]*/g, '').trim())
      .filter((p) => /^\w+$/.test(p));
    const propList = paramNames.map((p) => `${p}?: any`).join('; ');
    const propsType = paramNames.length ? `{ ${propList} }` : 'Record<string, any>';
    lines.push(`export declare function ${fnName}(args?: ${propsType}): string;`);
  }
  const slotsMatch = /__slots__:\s*(\[[^\]]*\])/.exec(jsSource);
  if (slotsMatch) {
    lines.push(`export declare const __slots__: ${slotsMatch[1].replace(/"/g, "'")};`);
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
    ...(ctx.definedVars || []),
  ]);
  for (const ref of ctx.refs || []) {
    if (JS_BUILTINS.has(ref) || known.has(ref) || ref.startsWith('_')) continue;
    params.push({ name: ref, default: '{}' });
    known.add(ref);
  }
}

function buildParamStr(params: ParamDecl[]): string {
  if (!params.length) return '';
  const inner = params
    .map((p) => {
      const safe = JS_RESERVED.has(p.name) ? `_${p.name}` : p.name;
      return safe === p.name
        ? `${p.name} = ${p.default}`
        : `${p.name}: ${safe} = ${p.default}`;
    })
    .join(', ');
  return `{ ${inner} } = {}`;
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
      if (m[1] !== m[1].toLowerCase()) restoreMap[m[1].toLowerCase()] = m[1];
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
    result = result.replaceAll(
      new RegExp(String.raw`(?<!\.)\b${name}\b`, 'g'),
      lower
    );
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
