import { parseDirectives } from './directives';
import type { Directives, SetDecl } from './directives';
import { convertExpr, convertAttrValue, convertTextContent } from './expr';

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
  fileOverrides: Record<string, string> = {},
): WalkerContext {
  return {
    uses: {},
    useDefaults: {},
    fileUse: {},
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

export function walkNodes(nodes: any[], ctx: WalkerContext): string {
  return nodes.map((node: any) => walkNode(node, ctx)).join('');
}

function walkNode(node: any, ctx: WalkerContext): string {
  switch (node.type) {
    case 'text':
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
    if (/^\w+$/.test(dir.resource) && !ctx.definedVars.has(dir.resource) && !ctx.uses[dir.resource]) {
      dir.resource = `'${dir.resource}'`;
    }
    addRootRefs(dir.resource, ctx.refs);
  }
  if (dir.element) addRootRefs(dir.element, ctx.refs);
  if (dir.unwrap != null) addRootRefs(dir.unwrap, ctx.refs);
  if (dir.repeat) addRootRefs(dir.repeat.listExpr, ctx.refs);
  if (dir.call)
    Object.values(dir.call.params).forEach((v) => addRootRefs(v, ctx.refs));
  for (const s of dir.sets) addRootRefs(s.expr, ctx.refs);
  if (dir.dynamicAttrs)
    for (const a of dir.dynamicAttrs) addRootRefs(a.expr, ctx.refs);
  if (dir.spreadAttr) addRootRefs(dir.spreadAttr, ctx.refs);

  for (const name of Object.keys(dir.use)) ctx.definedVars.add(name);
  for (const name of Object.keys(dir.fileUse)) ctx.definedVars.add(name);
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
    if (dotIdx === -1) {
      const localFn = ctx.localTemplates[fn];
      if (localFn) {
        const extraParams = paramsStr ? `${paramsStr}, _includes` : '_includes';
        callContent = `\${${localFn}?.({ ${extraParams} }) ?? ''}`;
      }
    } else {
      callObjName = fn.slice(0, dotIdx);
      const methodName = fn.slice(dotIdx + 1);
      const filePath = dir.fileUse[callObjName] || ctx.fileUse[callObjName];
      if (filePath && !ctx.uses[callObjName]) {
        const jsFnName =
          'create' + methodName.charAt(0).toUpperCase() + methodName.slice(1);
        const extraParams = paramsStr ? `${paramsStr}, _includes` : '_includes';
        callContent = `\${require('${filePath}').${jsFnName}?.({ ${extraParams} }) ?? ''}`;
      } else {
        const localFn = ctx.localTemplates[methodName];
        if (localFn) {
          const extraParams = paramsStr
            ? `${paramsStr}, _includes`
            : '_includes';
          callContent = `\${${localFn}?.({ ${extraParams} }) ?? ''}`;
        }
      }
    }

    if (!callContent) {
      const extraParams = paramsStr ? `${paramsStr}, _includes` : '_includes';
      callContent = `\${${fn}?.({ ${extraParams} }) ?? ''}`;
    }

    if (node.name !== 'sly') {
      const attrsStr = buildAttrs(attrsMap, dir, ctx.omitAttrs);
      const element = `<${node.name}${attrsStr}>${callContent}</${node.name}>`;
      return applyTest(dir.test, element);
    }

    return applyTest(dir.test, callContent);
  }

  if (dir.include) {
    const raw = dir.include;
    let key: string;
    if (raw.startsWith('${')) {
      const expr = convertExpr(raw);
      key = `[${expr}]`;
    } else {
      const literalPath = raw.replace(/^['"](.+)['"]$/, '$1');
      key = `['${literalPath}']`;
    }
    const includeExpr = `_includes${key}?.() ?? ''`;
    return applyTest(dir.test, `\${${includeExpr}}`);
  }

  if (node.name === 'sly' && !dir.repeat) {
    const rtArg = dir.resourceType ? "'" + dir.resourceType + "'" : 'undefined';
    const children = dir.resource
      ? `\${_wrapResource(${dir.resource}, _includes?.[${dir.resource}]?.() ?? '', Object.assign({}, _staticResourceWrappers ?? {}, _resourceWrappers), ${rtArg})}`
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
    const { varName, listExpr, listMode } = dir.repeat;
    const listVar = `${varName}List`;
    const listDecl = `const ${listVar} = { index: _i, count: _i + 1, first: _i === 0, last: _i === _arr.length - 1, odd: (_i + 1) % 2 !== 0, even: (_i + 1) % 2 === 0 };`;
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
      const childLoop = `\${((${listExpr}) || []).map((${varName}, _i, _arr) => { if (${varName} == null) return ''; ${childBody} }).join('')}`;
      result = VOID_ELEMENTS.has(node.name)
        ? `<${tagExpr}${attrsStr}>`
        : `<${tagExpr}${attrsStr}>${childLoop}</${tagExpr}>`;
    } else {
      const body = setLines
        ? `${listDecl} ${setLines} return \`${result}\`;`
        : `${listDecl} return \`${result}\`;`;
      result = `\${((${listExpr}) || []).map((${varName}, _i, _arr) => { if (${varName} == null) return ''; ${body} }).join('')}`;
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
    return `\${_wrapResource(${dir.resource}, _includes?.[${dir.resource}]?.() ?? '', Object.assign({}, _staticResourceWrappers ?? {}, _resourceWrappers), ${rtArg})}`;
  }
  if (dir.text) return `\${${dir.text}}`;
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
    .map(([key, val]) => ` ${key}="${convertAttrValue(val)}"`)
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
