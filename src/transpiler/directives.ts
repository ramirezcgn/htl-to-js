import fs from 'node:fs';
import path from 'node:path';
import { convertExpr, convertAttrValue } from './expr';

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
  test: string | null;
  repeat: { varName: string; listExpr: string; listMode: boolean } | null;
  element: string | null;
  unwrap: string | null;
  sets: SetDecl[];
  text: string | null;
  resource: string | null;
  template: { name: string; params: string[] } | null;
  call: CallDescriptor | null;
  include: string | null;
  dynamicAttrs?: { name: string; expr: string }[];
  spreadAttr?: string | null;
  skip: Set<string>;
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

  if (val.split('/').length > 2) return null;

  let dir = sourceDir;
  for (let i = 0; i < 4; i++) {
    const candidate = path.join(dir, val);
    if (fs.existsSync(candidate)) {
      const rel = path.relative(sourceDir, candidate).replaceAll('\\', '/');
      return rel.startsWith('.') ? rel : `./${rel}`;
    }
    dir = path.dirname(dir);
  }
  return null;
}

function parseUseDefault(val: string): string | null {
  const atIdx = val.indexOf('@');
  if (atIdx === -1) return null;
  const vals = [...val.slice(atIdx + 1).matchAll(/\w+\s*=\s*(\w+)/g)].map(m => m[1]);
  return vals.length ? `{ ${vals.join(', ')} }` : null;
}

/**
 * Parses all data-sly-* attributes from a node's attribute map and returns
 * a structured descriptor used by the walker to generate JS code.
 */
export function parseDirectives(attrs: Record<string, string>, sourceDir = ''): Directives {
  const directives: Directives = {
    use: {},
    useDefaults: {},
    fileUse: {},
    test: null,
    repeat: null,
    element: null,
    unwrap: null,
    sets: [],
    text: null,
    resource: null,
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
      const requirePath = sourceDir ? resolveHtlPath(trimmed, sourceDir) : null;
      if (requirePath) {
        directives.fileUse[name] = requirePath;
      } else {
        directives.use[name] = val;
        const def = parseUseDefault(trimmed);
        if (def) directives.useDefaults[name] = def;
      }
      directives.skip.add(key);
      continue;
    }

    if (key === 'data-sly-test') {
      directives.test = convertExpr(val);
      directives.skip.add(key);
      continue;
    }

    const testVarMatch = /^data-sly-test\.(\w+)$/.exec(key);
    if (testVarMatch) {
      const varName = testVarMatch[1];
      directives.sets.push({ name: varName, expr: convertExpr(val), raw: true });
      directives.test = varName;
      directives.skip.add(key);
      continue;
    }

    const repeatMatch = /^data-sly-(?:repeat|list)\.(\w+)$/.exec(key);
    if (repeatMatch) {
      directives.repeat = { varName: repeatMatch[1], listExpr: convertExpr(val), listMode: key.startsWith('data-sly-list.') };
      directives.skip.add(key);
      continue;
    }

    if (key === 'data-sly-list' || key === 'data-sly-repeat') {
      directives.repeat = { varName: 'item', listExpr: convertExpr(val), listMode: key === 'data-sly-list' };
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
      const isPureExpr = t.startsWith('${') && t.endsWith('}') && !t.slice(2, -1).includes('${');
      directives.sets.push(isPureExpr
        ? { name: setMatch[1], expr: convertExpr(t), raw: true }
        : { name: setMatch[1], expr: convertAttrValue(val) });
      directives.skip.add(key);
      continue;
    }

    if (key === 'data-sly-text') {
      directives.text = convertExpr(val);
      directives.skip.add(key);
      continue;
    }

    if (key === 'data-sly-resource') {
      let resource: string | null = convertExpr(val);
      if (!resource) {
        const pathMatch = /@\s*path\s*=\s*([^,}@\s'"]+)/.exec(val);
        if (pathMatch) resource = convertExpr('${' + pathMatch[1] + '}');
      }
      directives.resource = resource;
      directives.skip.add(key);
      continue;
    }

    const templateMatch = /^data-sly-template\.(\w+)$/.exec(key);
    if (templateMatch) {
      const params = [...val.matchAll(/@\s*(\w+)/g)].map(m => m[1]);
      directives.template = { name: templateMatch[1], params };
      directives.skip.add(key);
      continue;
    }

    const attrMatch = /^data-sly-attribute\.(.+)$/.exec(key);
    if (attrMatch) {
      const attrName = attrMatch[1];
      directives.dynamicAttrs ??= [];
      directives.dynamicAttrs.push({ name: attrName, expr: convertExpr(val) });
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
      directives.include = val;
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
  const inner = raw.trim().replace(/^\$\{([\s\S]+)\}$/, '$1').trim();
  const atIdx = inner.indexOf('@');
  const fn = (atIdx === -1 ? inner : inner.slice(0, atIdx)).trim();

  const params: Record<string, string> = {};
  if (atIdx !== -1) {
    const optStr = inner.slice(atIdx + 1);
    const valueRe = /(\w+)\s*=\s*((?:'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|\$\{(?:[^{}]|\{[^{}]*\})*\}|\[[^\]]*\]|[^,}])+)/g; // NOSONAR -- inherent complexity of HTL value parsing
    for (const m of optStr.matchAll(valueRe)) {
      params[m[1].trim()] = convertExpr(m[2].trim());
    }
  }

  return { fn, params };
}
