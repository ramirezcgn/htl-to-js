import { parseDirectives } from './directives';
import type { Directives, SetDecl } from './directives';
import {
  convertExpr,
  convertAttrValue,
  convertTextContent,
  extractExprs,
  extractContext,
  extractDynamicContext,
} from './expr';

const URI_ATTRS = new Set([
  'action',
  'cite',
  'data',
  'formaction',
  'href',
  'manifest',
  'poster',
  'src',
]);

const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

export interface WalkerContext {
  uses: Record<string, string>;
  useDefaults: Record<string, string>;
  fileUse: Record<string, string>;
  dynamicFileUse: Record<string, string>;
  jsFileUse: Record<string, string>;
  sets: SetDecl[];
  omitAttrs: RegExp[];
  sourceDir: string;
  refs: Set<string>;
  definedVars: Set<string>;
  localTemplates: Record<string, string>;
  fileOverrides: Record<string, string>;
}

export function createContext(
  omitAttrs: RegExp[] = [],
  sourceDir = '',
  fileOverrides: Record<string, string> = {}
): WalkerContext {
  return {
    uses: {},
    useDefaults: {},
    fileUse: {},
    dynamicFileUse: {},
    jsFileUse: {},
    sets: [],
    omitAttrs,
    sourceDir,
    refs: new Set(),
    definedVars: new Set(),
    localTemplates: {},
    fileOverrides,
  };
}

/**
 * Extracts root-level identifiers from a converted expression string,
 * ignoring string literal contents and property names after `.` or `?.`.
 */
function addRootRefs(expr: string | null | undefined, refs: Set<string>): void {
  if (!expr) return;
  const stripped = String(expr)
    .replaceAll(/'[^']*'/g, '')
    .replaceAll(/"[^"]*"/g, '');
  for (const m of stripped.matchAll(
    /(?<![?.])\b([a-zA-Z_$][a-zA-Z0-9_$]*)\b/g
  )) {
    if (
      stripped[m.index + m[0].length] === '$' &&
      stripped[m.index + m[0].length + 1] === '{'
    )
      continue;
    refs.add(m[1]);
  }
}

function formatCallParams(params: Record<string, string> | undefined): string {
  const entries = Object.entries(params ?? {});
  if (!entries.length) return 'undefined';
  return (
    '{ ' + entries.map(([key, value]) => key + ': ' + value).join(', ') + ' }'
  );
}

export function walkNodes(nodes: any[], ctx: WalkerContext): string {
  return nodes.map((node: any) => walkNode(node, ctx)).join('');
}

function walkNode(node: any, ctx: WalkerContext): string {
  switch (node.type) {
    case 'text':
      for (const { expr } of extractExprs(node.data)) {
        addRootRefs(expr, ctx.refs);
      }
      return convertTextContent(node.data);
    case 'comment':
      if (node.data?.trimStart().startsWith('/*')) return '';
      return `<!--${node.data}-->`;
    case 'root':
      return walkNodes(node.children, ctx);
    case 'tag':
    case 'script':
    case 'style':
      return processElement(node, ctx);
    default:
      return '';
  }
}

function processElement(node: any, ctx: WalkerContext): string {
  const attrsMap = node.attribs || {};
  const dir = parseDirectives(attrsMap, ctx.sourceDir);

  Object.assign(ctx.uses, dir.use);
  Object.assign(ctx.useDefaults, dir.useDefaults);
  Object.assign(ctx.fileUse, dir.fileUse);
  Object.assign(ctx.dynamicFileUse, dir.dynamicFileUse || {});
  Object.assign(ctx.jsFileUse, dir.jsFileUse);

  for (const [varName, filePath] of Object.entries(dir.fileUse)) {
    const basename = filePath.replace(/^.*[\\/]/, '');
    if (ctx.fileOverrides[filePath] || ctx.fileOverrides[basename]) {
      delete ctx.fileUse[varName];
      ctx.uses[varName] = filePath;
      ctx.useDefaults[varName] =
        ctx.fileOverrides[filePath] ?? ctx.fileOverrides[basename];
    }
  }

  for (const [varName, useVal] of Object.entries(dir.use)) {
    const trimmed = String(useVal).trim();
    if (trimmed.endsWith('.html')) {
      const basename = trimmed.replace(/^.*[\\/]/, '');
      const override =
        ctx.fileOverrides[trimmed] ?? ctx.fileOverrides[basename];
      if (override) {
        ctx.useDefaults[varName] = override;
      }
    }
  }

  if (dir.test) addRootRefs(dir.test, ctx.refs);
  if (dir.text) addRootRefs(dir.text, ctx.refs);
  if (dir.resource) {
    const resource = dir.resource;
    const definedOnSameElement = dir.sets.some((s) => s.name === resource.path);
    if (
      /^\w+$/.test(resource.path) &&
      !ctx.definedVars.has(resource.path) &&
      !ctx.uses[resource.path] &&
      !definedOnSameElement
    ) {
      resource.path = `'${resource.path}'`;
    }
    addRootRefs(resource.path, ctx.refs);
    for (const value of Object.values(resource.params))
      addRootRefs(value, ctx.refs);
  }
  if (dir.element) addRootRefs(dir.element, ctx.refs);
  if (dir.unwrap != null) addRootRefs(dir.unwrap, ctx.refs);
  if (dir.repeat) addRootRefs(dir.repeat.listExpr, ctx.refs);
  if (dir.call)
    Object.values(dir.call.params).forEach((v) => addRootRefs(v, ctx.refs));
  if (dir.include) {
    addRootRefs(dir.include.path, ctx.refs);
    for (const value of Object.values(dir.include.params))
      addRootRefs(value, ctx.refs);
  }
  for (const s of dir.sets) addRootRefs(s.expr, ctx.refs);
  if (dir.dynamicAttrs)
    for (const a of dir.dynamicAttrs) addRootRefs(a.expr, ctx.refs);
  if (dir.spreadAttr) addRootRefs(dir.spreadAttr, ctx.refs);
  for (const [attrKey, attrVal] of Object.entries(attrsMap)) {
    if (!attrKey.startsWith('data-sly-')) {
      for (const { expr } of extractExprs(String(attrVal))) {
        addRootRefs(expr, ctx.refs);
      }
    }
  }

  for (const name of Object.keys(dir.use)) ctx.definedVars.add(name);
  for (const name of Object.keys(dir.fileUse)) ctx.definedVars.add(name);
  for (const name of Object.keys(dir.dynamicFileUse || {}))
    ctx.definedVars.add(name);
  for (const s of dir.sets) ctx.definedVars.add(s.name);
  if (dir.repeat) {
    ctx.definedVars.add(dir.repeat.varName);
    ctx.definedVars.add(dir.repeat.varName + 'List');
    ctx.definedVars.add(dir.repeat.varName.toLowerCase() + 'List');
  }

  const localCtx: WalkerContext = dir.repeat
    ? {
        uses: ctx.uses,
        useDefaults: ctx.useDefaults,
        fileUse: ctx.fileUse,
        dynamicFileUse: ctx.dynamicFileUse,
        jsFileUse: ctx.jsFileUse,
        sets: [],
        omitAttrs: ctx.omitAttrs,
        sourceDir: ctx.sourceDir,
        refs: ctx.refs,
        definedVars: ctx.definedVars,
        localTemplates: ctx.localTemplates,
        fileOverrides: ctx.fileOverrides,
      }
    : ctx;

  for (const s of dir.sets) localCtx.sets.push(s);

  if (dir.template) return walkNodes(node.children, localCtx);

  if (dir.call) {
    const { fn, params } = dir.call;
    const paramsStr = Object.entries(params)
      .map(([k, v]) => `${k}: ${v}`)
      .join(', ');

    let callContent: string | undefined;
    let callObjName: string | undefined;
    const dotIdx = fn.indexOf('.');
    const isStaticCallTarget = /^\w+(?:\.\w+)*$/.test(fn);
    if (dotIdx === -1) {
      const localFn = ctx.localTemplates[fn];
      if (localFn) {
        const extraParams = paramsStr ? `${paramsStr}, _includes` : '_includes';
        callContent = `\${${localFn}?.({ ..._rest, ${extraParams} }) ?? ''}`;
      }
    } else {
      callObjName = fn.slice(0, dotIdx);
      const methodName = fn.slice(dotIdx + 1);
      const filePath = dir.fileUse[callObjName] || ctx.fileUse[callObjName];
      if (filePath && !ctx.uses[callObjName]) {
        const jsFnName =
          'create' + methodName.charAt(0).toUpperCase() + methodName.slice(1);
        const extraParams = paramsStr ? `${paramsStr}, _includes` : '_includes';
        callContent = `\${require('${filePath}').${jsFnName}?.({ ..._rest, ${extraParams} }) ?? ''}`;
      } else {
        const dynamicFilePath =
          dir.dynamicFileUse?.[callObjName] || ctx.dynamicFileUse[callObjName];
        if (dynamicFilePath && !ctx.uses[callObjName]) {
          const jsFnName =
            'create' + methodName.charAt(0).toUpperCase() + methodName.slice(1);
          const extraParams = paramsStr
            ? `${paramsStr}, _includes`
            : '_includes';
          const requirePath = dynamicFilePath.startsWith('`')
            ? dynamicFilePath
            : `(() => { const _usePath = String(${dynamicFilePath} ?? ''); return _usePath.startsWith('/') || _usePath.startsWith('.') ? _usePath : './' + _usePath; })()`;
          callContent = `\${require(${requirePath}).${jsFnName}?.({ ..._rest, ${extraParams} }) ?? ''}`;
        } else {
          const localFn = ctx.localTemplates[methodName];
          if (localFn) {
            const extraParams = paramsStr
              ? `${paramsStr}, _includes`
              : '_includes';
            callContent = `\${${localFn}?.({ ..._rest, ${extraParams} }) ?? ''}`;
          }
        }
      }
    }

    if (!callContent && !isStaticCallTarget) {
      const extraParams = paramsStr ? `${paramsStr}, _includes` : '_includes';
      callContent = `\${${convertExpr(fn)}?.({ ..._rest, ${extraParams} }) ?? ''}`;
    }

    if (!callContent) {
      const extraParams = paramsStr ? `${paramsStr}, _includes` : '_includes';
      callContent = `\${${fn}?.({ ..._rest, ${extraParams} }) ?? ''}`;
    }

    if (node.name !== 'sly') {
      const attrsStr = buildAttrs(attrsMap, dir, ctx.omitAttrs);
      const element = `<${node.name}${attrsStr}>${callContent}</${node.name}>`;
      return applyTest(dir.test, element);
    }

    return applyTest(dir.test, callContent);
  }

  if (dir.include) {
    const includeParams = formatCallParams(dir.include.params);
    const includeExpr =
      includeParams === 'undefined'
        ? `_incSlot(_includes, ${dir.include.path})`
        : `_incSlot(_includes, ${dir.include.path}, ${includeParams})`;
    return applyTest(dir.test, `\${${includeExpr}}`);
  }

  if (node.name === 'sly' && !dir.repeat) {
    const rtArg = dir.resourceType ? "'" + dir.resourceType + "'" : 'undefined';
    const children = dir.resource
      ? (() => {
          const resourceParams = formatCallParams(dir.resource.params);
          const slotParamsArg = resourceParams === 'undefined' ? 'undefined' : resourceParams;
          const decTagArg = dir.resource.decorationTagName ?? 'undefined';
          const cssClassArg = dir.resource.cssClassName ?? 'undefined';
          const decorationArg = dir.resource.decoration ?? 'undefined';
          return `\${_wrapResource(${dir.resource.path}, _includes, ${slotParamsArg}, Object.assign({}, _staticResourceWrappers ?? {}, _resourceWrappers), ${rtArg}, ${decTagArg}, ${cssClassArg}, ${decorationArg}, Object.assign({}, _staticResourceDecorations ?? {}, _resourceDecorations))}`;
        })()
      : walkNodes(node.children, localCtx);
    return applyTest(dir.test, children);
  }

  const tagExpr = dir.element
    ? `\${${dir.element} || '${node.name}'}`
    : node.name;

  const attrsStr = buildAttrs(attrsMap, dir, ctx.omitAttrs);
  const innerContent = buildInnerContent(node, dir, localCtx);

  const element =
    node.name === 'sly'
      ? innerContent
      : VOID_ELEMENTS.has(node.name)
        ? `<${tagExpr}${attrsStr}>`
        : `<${tagExpr}${attrsStr}>${innerContent}</${tagExpr}>`;

  let result = element;

  if (dir.unwrap !== null) {
    result = `\${(${dir.unwrap}) ? \`${innerContent}\` : \`${element}\`}`;
  }

  if (dir.repeat) {
    const { varName, listExpr, listMode, beginExpr, endExpr, stepExpr } =
      dir.repeat;
    const listVar = `${varName}List`;
    const listDecl = `const ${listVar} = { index: _i, count: _i + 1, first: _i === 0, middle: _i > 0 && _i < _arr.length - 1, last: _i === _arr.length - 1, odd: (_i + 1) % 2 !== 0, even: (_i + 1) % 2 === 0 };`;
    const baseArr = `(Array.isArray(${listExpr}) ? (${listExpr}) : [])`;
    const iterArr =
      (beginExpr ?? endExpr ?? stepExpr)
        ? `_htlSlice(${baseArr}, ${beginExpr ?? 'undefined'}, ${endExpr ?? 'undefined'}, ${stepExpr ?? 'undefined'})`
        : baseArr;
    const testVarName = dir.test;
    const hoisted: typeof localCtx.sets = [];
    const inner: typeof localCtx.sets = [];
    const seen = new Set<string>();
    for (const s of localCtx.sets) {
      if (seen.has(s.name)) continue;
      seen.add(s.name);
      if (testVarName && s.name === testVarName) hoisted.push(s);
      else inner.push(s);
    }

    const toDecl = (s: { name: string; expr: string; raw?: boolean }) => {
      const safe =
        s.name === 'class' || s.name === 'for' ? `_${s.name}` : s.name;
      return s.raw
        ? `const ${safe} = ${s.expr};`
        : `const ${safe} = \`${s.expr}\`;`;
    };

    const setLines = inner.map(toDecl).join(' ');
    const hoistLines = hoisted.map(toDecl).join(' ');

    if (listMode && node.name !== 'sly') {
      const childBody = setLines
        ? `${listDecl} ${setLines} return \`${innerContent}\`;`
        : `${listDecl} return \`${innerContent}\`;`;
      const mapExpr = `${iterArr}.map((${varName}, _i, _arr) => { if (${varName} == null) return ''; ${childBody} }).join('')`;
      result = VOID_ELEMENTS.has(node.name)
        ? `<${tagExpr}${attrsStr}>`
        : `\${((_la) => _la ? \`<${tagExpr}${attrsStr}>\${_la}</${tagExpr}>\` : '')(${mapExpr})}`;
    } else {
      const body = setLines
        ? `${listDecl} ${setLines} return \`${result}\`;`
        : `${listDecl} return \`${result}\`;`;
      result = `\${${iterArr}.map((${varName}, _i, _arr) => { if (${varName} == null) return ''; ${body} }).join('')}`;
    }

    if (hoistLines && dir.test) {
      const testExpr =
        dir.test === 'class' || dir.test === 'for' ? `_${dir.test}` : dir.test;
      result = `\${(() => { ${hoistLines} return (${testExpr}) ? \`${result}\` : ''; })()}`;
    } else {
      if (hoistLines) {
        result = `\${(() => { ${hoistLines} return \`${result}\`; })()}`;
      }
      if (dir.test) {
        result = applyTest(dir.test, result);
      }
    }
  } else if (dir.test) {
    result = applyTest(dir.test, result);
  }

  return result;
}

function buildInnerContent(
  node: any,
  dir: Directives,
  ctx: WalkerContext
): string {
  if (dir.resource) {
    const rtArg = dir.resourceType ? "'" + dir.resourceType + "'" : 'undefined';
    const resource = dir.resource;
    const resourceParams = formatCallParams(resource.params);
    const slotParamsArg = resourceParams === 'undefined' ? 'undefined' : resourceParams;
    const decTagArg = resource.decorationTagName ?? 'undefined';
    const cssClassArg = resource.cssClassName ?? 'undefined';
    const decorationArg = resource.decoration ?? 'undefined';
    return `\${_wrapResource(${resource.path}, _includes, ${slotParamsArg}, Object.assign({}, _staticResourceWrappers ?? {}, _resourceWrappers), ${rtArg}, ${decTagArg}, ${cssClassArg}, ${decorationArg}, Object.assign({}, _staticResourceDecorations ?? {}, _resourceDecorations))}`;
  }
  if (dir.text) {
    const isRaw = dir.textContext === 'html' || dir.textContext === 'unsafe';
    if (isRaw) return `\${${dir.text} ?? ''}`;
    if (dir.textDynamicContext)
      return `\${_htlCtx(${dir.text}, ${dir.textDynamicContext})}`;
    return `\${_htlText(${dir.text})}`;
  }
  return walkNodes(node.children, ctx);
}

function buildAttrs(
  attrsMap: Record<string, string>,
  dir: Directives,
  omitAttrs: RegExp[]
): string {
  let result = Object.entries(attrsMap)
    .filter(([key]) => !dir.skip.has(key))
    .filter(([key]) => !omitAttrs.some((pattern) => pattern.test(key)))
    .map(([key, val]) => {
      const exprs = extractExprs(val);
      if (
        exprs.length === 1 &&
        exprs[0].index === 0 &&
        exprs[0].end === val.length
      ) {
        const ctx = extractContext(exprs[0].expr);
        const converted = convertExpr(exprs[0].expr);
        if (ctx === 'unsafe') {
          return ` ${key}="\${${converted} ?? ''}"`;
        }
        if (ctx === 'uri' || (ctx == null && URI_ATTRS.has(key))) {
          return `\${_htlDynAttr('${key}', _htlUri(${converted}))}`;
        }
        if (ctx === 'number') {
          return `\${_htlDynAttr('${key}', _htlNum(${converted}))}`;
        }
        const dynCtx =
          ctx == null ? extractDynamicContext(exprs[0].expr) : null;
        if (dynCtx != null) {
          return `\${_htlDynAttrCtx('${key}', ${converted}, ${dynCtx})}`;
        }
        return `\${_htlDynAttr('${key}', ${converted})}`;
      }
      return ` ${key}="${convertAttrValue(val)}"`;
    })
    .join('');

  if (dir.dynamicAttrs?.length) {
    for (const { name, expr } of dir.dynamicAttrs) {
      result += `\${_htlDynAttr('${name}', ${expr})}`;
    }
  }

  if (dir.spreadAttr) {
    result += `\${_htlSpreadAttrs(${dir.spreadAttr})}`;
  }

  return result;
}

function applyTest(condition: string | null, content: string): string {
  if (!condition) return content;
  return `\${(${condition}) ? \`${content}\` : ''}`;
}
