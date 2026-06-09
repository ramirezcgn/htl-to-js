/**
 * Splits an HTL expression at the first @ that sits at the top level —
 * i.e. not inside a string literal, parentheses, or brackets.
 * Returns [valuePart, optionsPart] where optionsPart is null when there is no @.
 */
export function splitAtAtSign(expr: string): [string, string | null] {
  let inStr: string | null = null;
  let depth = 0;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (inStr) {
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === "'" || c === '"') {
      inStr = c;
      continue;
    }
    if (c === '(' || c === '[') {
      depth++;
      continue;
    }
    if (c === ')' || c === ']') {
      depth--;
      continue;
    }
    if (c === '@' && depth === 0) {
      return [expr.slice(0, i).trim(), expr.slice(i + 1).trim()];
    }
  }
  return [expr.trim(), null];
}

/**
 * Applies value-level HTL-to-JS transforms to an expression fragment:
 * optional chaining, .size → .length, jcr: property access, in-operator,
 * and reserved-word renaming (class, for).
 *
 * String literals inside the expression are protected so their content is
 * never accidentally modified.
 */
function transformValue(expr: string): string {
  // Protect string literals from being mangled by the transforms below.
  const strings: string[] = [];
  let result = expr.replace(/'[^']*'|"[^"]*"/g, (m) => {
    strings.push(m);
    return `__STR${strings.length - 1}__`;
  });

  // Protect array literals (used in @format args etc.)
  const arrays: string[] = [];
  result = result.replace(/\[[^\]]*\]/g, (m) => {
    arrays.push(m);
    return `__ARR${arrays.length - 1}__`;
  });

  result = result
    .replace(
      /([\w$](?:[\w$.?]|__ARR\d+__|__STR\d+__)*)\.size\b/g,
      (_, lhs) => `_htlSize(${lhs})`
    )
    .replace(/(\w+)\.jcr:(\w+)/g, "$1?.['jcr:$2']")
    .trim();

  // Restore arrays before optional-chaining so a[i] becomes a?.[i].
  arrays.forEach((arr, i) => {
    result = result.replace(`__ARR${i}__`, arr);
  });

  result = result
    .replace(/(\w|\])(?<!\?)\[/g, '$1?.[')
    .replace(/(\w|\])\.(?=([\w$]))/g, (m, a: string, b: string) =>
      /\d/.test(a) && /\d/.test(b) ? m : `${a}?.`
    )
    .replace(
      /([\w$.?[\]]+)\s+in\s+([\w$.?[\]]+)/g,
      (_match, left: string, right: string) => `_htlIn(${left}, ${right})`
    )
    .replace(/(?<![?.])\b(class|for)\b/g, '_$1');

  // Restore string literals last so their content is never touched.
  strings.forEach((str, i) => {
    result = result.replace(`__STR${i}__`, str);
  });

  return result;
}

/**
 * Converts a raw HTL expression (with or without ${}) to a JS expression string.
 *
 * Examples:
 *   "${items.size > 0}"  →  "items.length > 0"
 *   "'Text' @ i18n"         →  "'Text'"
 *   "${model.title @ context='html'}" → "model.title"
 */
export function convertExpr(raw: string): string {
  if (!raw?.trim()) return raw;

  let inner = raw.trim();
  if (inner.startsWith('${') && inner.endsWith('}')) {
    inner = inner.slice(2, -1).trim();
  }

  // Split at the first top-level @ so that @ inside string literals is
  // never mistaken for the option separator.
  const [valuePart, optStr] = splitAtAtSign(inner);

  // --- Parse options from the options string only ---
  const hasI18n = optStr != null && /(?:^|,)\s*i18n\b/.test(optStr);
  const i18nLiteralMatch = hasI18n
    ? /^\s*(['"])([^'"]*?)\1\s*$/.exec(valuePart)
    : null;
  const hasVarI18n = hasI18n && i18nLiteralMatch == null;

  const countRaw =
    optStr == null
      ? null
      : /\bcount\s*=\s*((?:'[^']*'|"[^"]*"|[^,\s'")}]+))/.exec(optStr)?.[1];

  const joinMatch =
    optStr == null ? null : /\bjoin\s*=\s*(?:'([^']*)'|"([^"]*)")/.exec(optStr);

  const formatArgs =
    optStr == null ? null : /\bformat\s*=\s*\[([^\]]*)\]/.exec(optStr)?.[1];

  const urlencodeMatch =
    optStr != null && /\bcontext\s*=\s*['"]urlencode['"]/i.test(optStr);

  // --- Apply @format: expand a string template against an argument list ---
  if (formatArgs != null) {
    const templateMatch = /^\s*(['"])([^'"]*)\1\s*$/.exec(valuePart);
    if (templateMatch) {
      const tmpl = templateMatch[2];
      const args = formatArgs.split(',').map((a) => a.trim());
      const parts = tmpl.split(/\{(\d+)\}/);
      const result =
        parts
          .map((part, i) =>
            i % 2 === 1
              ? args[Number.parseInt(part)]
                ? transformValue(args[Number.parseInt(part)])
                : "''"
              : part
                ? `'${part}'`
                : null
          )
          .filter(Boolean)
          .join(' + ') || "''";
      return urlencodeMatch ? `encodeURIComponent(${result} ?? '')` : result;
    }
  }

  // --- Apply value-level transforms ---
  let value = transformValue(valuePart);

  // --- Apply @join ---
  if (joinMatch) {
    const sep = joinMatch[1] ?? joinMatch[2];
    value = `(${value} ?? []).join('${sep}')`;
  }

  // --- Apply @i18n / @count (pluralisation) ---
  if (i18nLiteralMatch) {
    const key = i18nLiteralMatch[2].replaceAll("'", String.raw`\'`);
    if (countRaw == null) {
      value = `_i18n?.['${key}'] ?? ${valuePart}`;
    } else {
      value = `_htlI18nPlural('${key}', ${convertExpr(countRaw)}, _i18n)`;
    }
  } else if (hasVarI18n) {
    const needsParens = /\|\||&&/.test(value);
    const safe = needsParens ? `(${value})` : value;
    if (countRaw == null) {
      value = `_i18n?.[${safe}] ?? ${safe}`;
    } else {
      value = `_htlI18nPlural(${safe}, ${convertExpr(countRaw)}, _i18n)`;
    }
  }

  // --- Apply @context='urlencode' ---
  if (urlencodeMatch) {
    value = `encodeURIComponent(${value} ?? '')`;
  }

  return value;
}

interface ExprMatch {
  index: number;
  expr: string;
  end: number;
}

/**
 * Extracts all ${...} HTL expressions from a string, correctly handling
 * any depth of nested braces and string literals inside expressions
 * (e.g. `${'hello}world'}` or `${'a' == 'b' ? '}' : '{'}`).
 */
export function extractExprs(str: string): ExprMatch[] {
  const results: ExprMatch[] = [];
  let i = 0;
  while (i < str.length) {
    const start = str.indexOf('${', i);
    if (start === -1) break;
    let depth = 0;
    let j = start;
    let inStr: string | null = null;
    for (; j < str.length; j++) {
      const c = str[j];
      if (inStr) {
        if (c === '\\') {
          j++;
          continue;
        }
        if (c === inStr) inStr = null;
        continue;
      }
      if (c === "'" || c === '"') {
        inStr = c;
        continue;
      }
      if (c === '{') {
        depth++;
        continue;
      }
      if (c === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth === 0) {
      results.push({ index: start, expr: str.slice(start + 2, j), end: j + 1 });
    }
    i = j + 1;
  }
  return results;
}

/**
 * Extracts the @ context='...' value from a raw HTL expression string.
 * Returns the lowercase context name, or null if not specified or if the
 * context is a dynamic (non-quoted) expression.
 */
export function extractContext(raw: string): string | null {
  const m = /\bcontext\s*=\s*['"](\w+)['"]/.exec(raw);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Extracts a *dynamic* context expression from a raw HTL expression — i.e. when
 * the context value is not a quoted string literal but a JS expression such as
 * `model.isRich ? 'html' : 'text'`.
 *
 * Returns the converted JS expression string, or null when the context is absent
 * or already handled as a static string by extractContext.
 */
export function extractDynamicContext(raw: string): string | null {
  let inner = raw.trim();
  if (inner.startsWith('${') && inner.endsWith('}')) {
    inner = inner.slice(2, -1).trim();
  }
  const [, optStr] = splitAtAtSign(inner);
  if (!optStr) return null;
  // Static context is handled by extractContext — don't duplicate here.
  if (/\bcontext\s*=\s*['"]/.test(optStr)) return null;
  // Extract the context value, which may contain nested quotes (e.g. ternaries).
  const m = /\bcontext\s*=\s*((?:'[^']*'|"[^"]*"|[^,}])+)/.exec(optStr);
  if (!m) return null;
  const ctxRaw = m[1].trim();
  if (!ctxRaw) return null;
  return convertExpr(ctxRaw);
}

/**
 * Converts all ${htlExpr} occurrences within an attribute value string,
 * while escaping literal backticks and bare $ signs.
 * Respects @ context option: 'unsafe' skips HTML-escaping, 'uri' applies URI encoding.
 */
export function convertAttrValue(value: string): string {
  const parts: string[] = [];
  let last = 0;
  for (const { index, expr, end } of extractExprs(value)) {
    if (index > last) parts.push(escapeLiteral(value.slice(last, index)));
    const ctx = extractContext(expr);
    const converted = convertExpr(expr);
    if (ctx === 'unsafe') {
      const safe = /\|\||&&/.test(converted) ? `(${converted})` : converted;
      parts.push(`\${${safe} ?? ''}`);
    } else if (ctx === 'uri') {
      parts.push(`\${_htlUri(${converted})}`);
    } else if (ctx === 'number') {
      parts.push(`\${_htlNum(${converted}) ?? ''}`);
    } else {
      const dynCtx = extractDynamicContext(expr);
      if (dynCtx == null) {
        parts.push(`\${_htlAttr(${converted})}`);
      } else {
        parts.push(`\${_htlCtxAttr(${converted}, ${dynCtx})}`);
      }
    }
    last = end;
  }
  if (last < value.length) parts.push(escapeLiteral(value.slice(last)));
  return parts.join('');
}

/**
 * Converts HTL expressions in text node content, escaping everything else
 * for safe embedding in a JS template literal.
 */
export function convertTextContent(text: string): string {
  const parts: string[] = [];
  let last = 0;
  for (const { index, expr, end } of extractExprs(text)) {
    if (index > last) parts.push(escapeLiteral(text.slice(last, index)));
    const ctx = extractContext(expr);
    const converted = convertExpr(expr);
    if (ctx === 'html' || ctx === 'unsafe') {
      const safe = /\|\||&&/.test(converted) ? `(${converted})` : converted;
      parts.push(`\${${safe} ?? ''}`);
    } else if (ctx === 'number') {
      parts.push(`\${_htlNum(${converted}) ?? ''}`);
    } else {
      const dynCtx = extractDynamicContext(expr);
      if (dynCtx == null) {
        parts.push(`\${_htlText(${converted})}`);
      } else {
        parts.push(`\${_htlCtx(${converted}, ${dynCtx})}`);
      }
    }
    last = end;
  }
  if (last < text.length) parts.push(escapeLiteral(text.slice(last)));
  return parts.join('');
}

/**
 * Escapes characters that would break a JS template literal.
 */
export function escapeLiteral(str: string): string {
  return str
    .replaceAll('\\', '\\\\')
    .replaceAll('`', String.raw`\``)
    .replaceAll(/\$(?!\{)/g, String.raw`\$`);
}
