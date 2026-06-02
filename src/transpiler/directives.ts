import fs from 'node:fs';
import path from 'node:path';
import { convertExpr, convertAttrValue, escapeLiteral, extractExprs, extractContext } from './expr';

export interface SetDecl {
  name: string;
  expr: string;
  raw?: boolean;
}

export interface CallDescriptor {
  fn: string;
  params: Record<string, string>;
}

export interface Directives {
  use: Record<string, string>;
  useDefaults: Record<string, string>;
  fileUse: Record<string, string>;
  dynamicFileUse: Record<string, string>;
  jsFileUse: Record<string, string>;
  test: string | null;
  repeat: { varName: string; listExpr: string; listMode: boolean; beginExpr: string | null; endExpr: string | null; stepExpr: string | null } | null;
  element: string | null;
  unwrap: string | null;
  sets: SetDecl[];
  text: string | null;
  textContext: string | null;
  resource: { path: string; params: Record<string, string> } | null;
  resourceType: string | null;
  template: { name: string; params: string[] } | null;
  call: CallDescriptor | null;
  include: { path: string; params: Record<string, string> } | null;
  dynamicAttrs?: { name: string; expr: string }[];
  spreadAttr?: string | null;
  skip: Set<string>;
}

/**
 * Resolves a JS or JSON data-sly-use path to a require()-ready relative path.
 * Walks up the directory tree (up to 4 levels) to find the file.
 * Returns a './relative/path.js' or './relative/path.json' string, or null.
 */
function resolveCandidatePath(
  val: string,
  sourceDir: string,
  maxLevels: number,
): string | null {
  let dir = sourceDir;
  for (let i = 0; i < maxLevels; i++) {
    const candidate = path.join(dir, val);
    if (fs.existsSync(candidate)) {
      const rel = path.relative(sourceDir, candidate).replaceAll('\\', '/');
      return rel.startsWith('.') ? rel : `./${rel}`;
    }
    dir = path.dirname(dir);
  }
  return null;
}

function resolveWithinJcrRoot(val: string, sourceDir: string): string | null {
  let dir = sourceDir;
  for (let i = 0; i < 10; i++) {
    const jcrRoot = path.join(dir, 'jcr_root');
    if (fs.existsSync(jcrRoot)) {
      const candidate = path.join(jcrRoot, val);
      if (fs.existsSync(candidate)) {
        const rel = path.relative(sourceDir, candidate).replaceAll('\\', '/');
        return rel.startsWith('.') ? rel : `./${rel}`;
      }
      return null;
    }
    dir = path.dirname(dir);
  }
  return null;
}

function resolveJsUsePath(val: string, sourceDir: string): string | null {
  if (!sourceDir) return null;
  if (val.includes('${')) return null;
  const isJs = val.endsWith('.js');
  const isJson = val.endsWith('.json');
  if (!isJs && !isJson) return null;

  if (val.startsWith('/')) {
    return resolveWithinJcrRoot(val, sourceDir);
  }

  return resolveCandidatePath(val, sourceDir, 4);
}

/**
 * Resolves an HTL data-sly-use file path to a require()-ready relative path.
 * AEM resolves paths relative to the component root, not the current file,
 * so we walk up the directory tree until the file is found.
 * Returns a './relative/path.html' string, or null if not resolvable locally.
 */
function resolveHtlPath(val: string, sourceDir: string): string | null {
  if (!val.endsWith('.html') || val.includes('${')) return null;

  if (val.startsWith('/')) {
    return resolveWithinJcrRoot(val, sourceDir);
  }

  if (val.split('/').length > 2) return null;

  return resolveCandidatePath(val, sourceDir, 4);
}

function parseUseDefault(val: string): string | null {
  const atIdx = val.indexOf('@');
  if (atIdx === -1) return null;
  const vals = [...val.slice(atIdx + 1).matchAll(/\w+\s*=\s*(\w+)/g)].map(
    (m) => m[1]
  );
  return vals.length ? `{ ${vals.join(', ')} }` : null;
}

function parseHtlOptions(value: string): Record<string, string> {
  const options: Record<string, string> = {};
  const valueRe = /(\w+)\s*=\s*((?:'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|\$\{(?:[^{}]|\{[^{}]*\})*\}|\[[^\]]*\]|[^,}])+)/g;
  for (const match of value.matchAll(valueRe)) {
    options[match[1].trim()] = convertExpr(match[2].trim());
  }
  return options;
}

function parseHtlPathAndOptions(raw: string): { path: string; params: Record<string, string> } {
  const trimmed = raw.trim();
  const isWrappedExpr = trimmed.startsWith('${') && trimmed.endsWith('}');
  const inner = isWrappedExpr ? trimmed.slice(2, -1).trim() : trimmed;
  const atIdx = inner.indexOf('@');
  const pathPart = (atIdx === -1 ? inner : inner.slice(0, atIdx)).trim();
  const params = atIdx === -1 ? {} : parseHtlOptions(inner.slice(atIdx + 1));
  const overridePath = params.path;
  if (overridePath) delete params.path;
  const literalPath = pathPart.replace(/^['"](.+)['"]$/, '$1').replaceAll("'", String.raw`\'`);
  const pathExpr = overridePath ?? (isWrappedExpr || pathPart.startsWith('${')
    ? convertExpr('${' + pathPart + '}')
    : "'" + literalPath + "'");

  const appendPath = params.appendPath as string | undefined;
  const prependPath = params.prependPath as string | undefined;
  delete params.appendPath;
  delete params.prependPath;
  const finalPath = composeHtlPath(pathExpr, prependPath, appendPath);
  return { path: finalPath, params };
}

/**
 * Composes an HTL path expression with optional prependPath/appendPath options.
 * Uses compile-time string concatenation when both operands are static string
 * literals; falls back to a runtime `_htlJoinPaths` call otherwise.
 */
function composeHtlPath(
  pathExpr: string,
  prependExpr: string | undefined,
  appendExpr: string | undefined,
): string {
  if (!prependExpr && !appendExpr) return pathExpr;

  const staticBase = /^'([^']*)'$/.exec(pathExpr)?.[1];
  const staticPrepend = prependExpr ? /^'([^']*)'$/.exec(prependExpr)?.[1] : undefined;
  const staticAppend = appendExpr ? /^'([^']*)'$/.exec(appendExpr)?.[1] : undefined;

  if (staticBase !== undefined) {
    let composed = staticBase;
    if (prependExpr !== undefined) {
      if (staticPrepend === undefined) {
        return `_htlJoinPaths('${composed}', ${prependExpr}, ${appendExpr ?? 'undefined'})`;
      }
      composed =
        staticPrepend.replace(/\/$/, '') + '/' + composed.replace(/^\//, '');
    }
    if (appendExpr !== undefined) {
      if (staticAppend === undefined) {
        return `_htlJoinPaths('${composed}', undefined, ${appendExpr})`; 
      }
      composed =
        composed.replace(/\/$/, '') + '/' + staticAppend.replace(/^\//, '');
    }
    return `'${composed}'`;
  }

  return `_htlJoinPaths(${pathExpr}, ${prependExpr ?? 'undefined'}, ${appendExpr ?? 'undefined'})`;
}

function unwrapPureStringExpression(val: string): string | null {
  const match = /^\$\{\s*(['"])([\s\S]*)\1\s*\}$/.exec(val.trim());
  return match ? match[2] : null;
}

function convertInterpolatedString(value: string): string {
  const parts: string[] = [];
  let last = 0;
  for (const { index, expr, end } of extractExprs(value)) {
    if (index > last) parts.push(escapeLiteral(value.slice(last, index)));
    parts.push(`\${${convertExpr(expr)}}`);
    last = end;
  }
  if (last < value.length) parts.push(escapeLiteral(value.slice(last)));
  return '`' + parts.join('') + '`';
}

function buildDynamicJsUseDefault(pathExpr: string): string {
  return `(() => { const _m = require(__resolveUsePath(${pathExpr})); return typeof _m === 'function' ? _m({}) : _m; })()`;
}

/**
 * Extracts begin / end / step iteration-control options from a data-sly-list or
 * data-sly-repeat attribute value. Returns null for each option not present.
 */
function parseRepeatIterationOptions(
  raw: string,
): { beginExpr: string | null; endExpr: string | null; stepExpr: string | null } {
  const trimmed = raw.trim();
  const inner = trimmed.startsWith('${') && trimmed.endsWith('}')
    ? trimmed.slice(2, -1).trim() : trimmed;
  const atIdx = inner.indexOf('@');
  if (atIdx === -1) return { beginExpr: null, endExpr: null, stepExpr: null };
  const opts = parseHtlOptions(inner.slice(atIdx + 1));
  return {
    beginExpr: opts.begin ?? null,
    endExpr: opts.end ?? null,
    stepExpr: opts.step ?? null,
  };
}

/**
 * Parses all data-sly-* attributes from a node's attribute map and returns
 * a structured descriptor used by the walker to generate JS code.
 */
export function parseDirectives(
  attrs: Record<string, string>,
  sourceDir = ''
): Directives {
  const directives: Directives = {
    use: {},
    useDefaults: {},
    fileUse: {},
    dynamicFileUse: {},
    jsFileUse: {},
    test: null,
    repeat: null,
    element: null,
    unwrap: null,
    sets: [],
    text: null,
    textContext: null,
    resource: null,
    resourceType: null,
    template: null,
    call: null,
    include: null,
    skip: new Set(),
  };

  for (const [key, val] of Object.entries(attrs)) {
    const useMatch = /^data-sly-use\.(\w+)$/.exec(key);
    if (useMatch) {
      const name = useMatch[1];
      const trimmed = val.trim();
      const literalExpr = unwrapPureStringExpression(trimmed);
      const staticCandidate = literalExpr ?? trimmed;
      const requirePath = sourceDir ? resolveHtlPath(staticCandidate, sourceDir) : null;
      const jsRequirePath = requirePath ? null : (sourceDir ? resolveJsUsePath(staticCandidate, sourceDir) : null);
      if (requirePath) {
        directives.fileUse[name] = requirePath;
      } else if (jsRequirePath) {
        directives.jsFileUse[name] = jsRequirePath;
      } else if (trimmed.includes('${') && (trimmed.endsWith('.js') || trimmed.endsWith('.json'))) {
        directives.use[name] = val;
        directives.useDefaults[name] = buildDynamicJsUseDefault(convertInterpolatedString(trimmed));
      } else if (trimmed.includes('${') && trimmed.endsWith('.html')) {
        directives.dynamicFileUse[name] = `__resolveUsePath(${convertInterpolatedString(trimmed)})`;
      } else {
        directives.use[name] = val;
        const def = parseUseDefault(trimmed);
        if (def) directives.useDefaults[name] = def;
      }
      directives.skip.add(key);
      continue;
    }

    if (key === 'data-sly-test') {
      directives.test = val.trim() ? convertExpr(val) : 'false';
      directives.skip.add(key);
      continue;
    }

    const testVarMatch = /^data-sly-test\.(\w+)$/.exec(key);
    if (testVarMatch) {
      const varName = testVarMatch[1];
      directives.sets.push({
        name: varName,
        expr: convertExpr(val),
        raw: true,
      });
      directives.test = varName;
      directives.skip.add(key);
      continue;
    }

    const repeatMatch = /^data-sly-(?:repeat|list)\.(\w+)$/.exec(key);
    if (repeatMatch) {
      const { beginExpr, endExpr, stepExpr } = parseRepeatIterationOptions(val);
      directives.repeat = {
        varName: repeatMatch[1],
        listExpr: convertExpr(val),
        listMode: key.startsWith('data-sly-list.'),
        beginExpr,
        endExpr,
        stepExpr,
      };
      directives.skip.add(key);
      continue;
    }

    if (key === 'data-sly-list' || key === 'data-sly-repeat') {
      const { beginExpr, endExpr, stepExpr } = parseRepeatIterationOptions(val);
      directives.repeat = {
        varName: 'item',
        listExpr: convertExpr(val),
        listMode: key === 'data-sly-list',
        beginExpr,
        endExpr,
        stepExpr,
      };
      directives.skip.add(key);
      continue;
    }

    if (key === 'data-sly-element') {
      directives.element = convertExpr(val);
      directives.skip.add(key);
      continue;
    }

    if (key === 'data-sly-unwrap') {
      directives.unwrap = val.trim() ? convertExpr(val) : 'true';
      directives.skip.add(key);
      continue;
    }

    const setMatch = /^data-sly-set\.(\w+)$/.exec(key);
    if (setMatch) {
      const t = val.trim();
      const isPureExpr =
        t.startsWith('${') && t.endsWith('}') && !t.slice(2, -1).includes('${');
      directives.sets.push(
        isPureExpr
          ? { name: setMatch[1], expr: convertExpr(t), raw: true }
          : { name: setMatch[1], expr: convertAttrValue(val) }
      );
      directives.skip.add(key);
      continue;
    }

    if (key === 'data-sly-text') {
      directives.text = convertExpr(val);
      directives.textContext = extractContext(val);
      directives.skip.add(key);
      continue;
    }

    if (key === 'data-sly-resource') {
      const parsed = parseHtlPathAndOptions(val);
      const rtMatch = /@\s*resourceType\s*=\s*['"]([^'"]+)['"]/.exec(val);
      if (rtMatch) directives.resourceType = rtMatch[1];
      const params = { ...parsed.params } as Record<string, string> & { resourceType?: string; path?: string };
      const { resourceType } = params;
      delete params.resourceType;
      delete params.path;
      if (resourceType && !directives.resourceType) directives.resourceType = resourceType;
      directives.resource = { path: parsed.path, params };
      directives.skip.add(key);
      continue;
    }

    const templateMatch = /^data-sly-template\.(\w+)$/.exec(key);
    if (templateMatch) {
      const params = [...val.matchAll(/@\s*(\w+)/g)].map((m) => m[1]);
      directives.template = { name: templateMatch[1], params };
      directives.skip.add(key);
      continue;
    }

    const attrMatch = /^data-sly-attribute\.(.+)$/.exec(key);
    if (attrMatch) {
      const attrName = attrMatch[1];
      directives.dynamicAttrs ??= [];
      const t = val.trim();
      const exprs = extractExprs(t);
      const isPureExpr =
        exprs.length === 1 && exprs[0].index === 0 && exprs[0].end === t.length;
      if (isPureExpr) {
        directives.dynamicAttrs.push({
          name: attrName,
          expr: convertExpr(val),
        });
      } else if (exprs.length > 0) {
        const parts: string[] = [];
        let last = 0;
        for (const { index, expr: e, end } of exprs) {
          if (index > last)
            parts.push(t.slice(last, index).replaceAll('`', '\\`'));
          parts.push(`\${${convertExpr(e)}}`);
          last = end;
        }
        if (last < t.length) parts.push(t.slice(last).replaceAll('`', '\\`'));
        directives.dynamicAttrs.push({
          name: attrName,
          expr: '`' + parts.join('') + '`',
        });
      } else {
        const escaped = t.replaceAll("'", String.raw`\'`);
        directives.dynamicAttrs.push({
          name: attrName,
          expr: "'" + escaped + "'",
        });
      }
      directives.skip.add(key);
      directives.skip.add(attrName);
      continue;
    }

    if (key === 'data-sly-attribute') {
      directives.spreadAttr = convertExpr(val);
      directives.skip.add(key);
      continue;
    }

    if (key === 'data-sly-include') {
      directives.include = parseHtlPathAndOptions(val);
      directives.skip.add(key);
      continue;
    }

    if (key === 'data-sly-call') {
      directives.call = parseCallExpr(val);
      directives.skip.add(key);
    }
  }

  return directives;
}

/**
 * Parses a data-sly-call expression into a callable descriptor.
 *
 * Input:  "${template.default @ model=item, title=item.title}"
 * Output: { fn: "template.default", params: { model: "item", title: "item.title" } }
 */
function parseCallExpr(raw: string): CallDescriptor {
  const inner = raw
    .trim()
    .replace(/^\$\{([\s\S]+)\}$/, '$1')
    .trim();
  const atIdx = inner.indexOf('@');
  const fn = (atIdx === -1 ? inner : inner.slice(0, atIdx)).trim();

  const params: Record<string, string> = {};
  if (atIdx !== -1) {
    const optStr = inner.slice(atIdx + 1);
    const valueRe =
      /(\w+)\s*=\s*((?:'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|\$\{(?:[^{}]|\{[^{}]*\})*\}|\[[^\]]*\]|[^,}])+)/g; // NOSONAR -- inherent complexity of HTL value parsing
    for (const m of optStr.matchAll(valueRe)) {
      params[m[1].trim()] = convertExpr(m[2].trim());
    }
  }

  return { fn, params };
}
