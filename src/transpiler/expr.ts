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

  const i18nMatch = /^\s*(['"])([^'"]*?)\1\s*@\s*(?:.*,\s*)?i18n\b/.exec(inner);

  inner = inner.replace(
    /^([\s\S]+?)\s*@\s*join\s*=\s*(?:'([^']*)'|"([^"]*)")/,
    (_: string, expr: string, sepSingle: string, sepDouble: string) => {
      const sep = sepSingle ?? sepDouble;
      return `(${expr.trim()}).join('${sep}')`;
    }
  );

  inner = inner.replaceAll(
    /['"]([^'"]*)['"]\s*@\s*format=\[([^\]]*)\]/g,
    (_: string, tmpl: string, args: string) => {
      const argList = args.split(',').map((a) => a.trim());
      const parts = tmpl.split(/\{(\d+)\}/);
      return (
        parts
          .map((part, i) =>
            i % 2 === 1
              ? argList[Number.parseInt(part)] || "''"
              : part
                ? `'${part}'`
                : null
          )
          .filter(Boolean)
          .join(' + ') || "''"
      );
    }
  );

  const arrays: string[] = [];
  inner = inner.replaceAll(/\[[^\]]*\]/g, (m) => {
    arrays.push(m);
    return `__ARR${arrays.length - 1}__`;
  });

  const urlencodeMatch = /\s*@\s*(?:.*,\s*)?context\s*=\s*['"]urlencode['"]/i.test(inner);

  const OPT_VAL = String.raw`(?:'[^']*'|"[^"]*"|__ARR\d+__|(?:[^,@}'"\n]|'[^']*'|"[^"]*")+)`;
  inner = inner
    .replaceAll(new RegExp(String.raw`\s*@\s*[\w]+\s*=\s*${OPT_VAL}`, 'g'), '')
    .replaceAll(new RegExp(String.raw`,\s*\w+\s*=\s*${OPT_VAL}`, 'g'), '')
    .replaceAll(/,\s*\w+\b(?!\s*[=.(])/g, '')
    .replaceAll(/\s*@\s*\w+\b/g, '')
    .replaceAll(/\s*@\s*$/g, '')
    .replaceAll(/\.size\b/g, '.length')
    .replaceAll(/(\w+)\.jcr:(\w+)/g, "$1?.['jcr:$2']")
    .trim();

  arrays.forEach((arr, i) => {
    inner = inner.replace(`__ARR${i}__`, arr);
  });

  inner = inner.replaceAll(/(\w|\])(?<!\?)\[/g, '$1?.[');
  inner = inner.replaceAll(/(\w|\])\.(?=([\w$]))/g, (m, a, b) =>
    /\d/.test(a) && /\d/.test(b) ? m : `${a}?.`
  );
  inner = inner.replaceAll(
    /([\w$.?[\]]+)\s+in\s+([\w$.?[\]]+)/g,
    (_match: string, left: string, right: string) => {
      return `(${right}) && (${left} in ${right})`;
    }
  );

  inner = inner.replaceAll(/(?<![?.])\b(class|for)\b/g, '_$1');
  if (i18nMatch) {
    const escapedKey = i18nMatch[2].replaceAll("'", String.raw`\'`);
    inner = "_i18n?.['" + escapedKey + "'] ?? " + inner;
  }
  if (urlencodeMatch) {
    inner = `encodeURIComponent(${inner} ?? '')`;
  }
  return inner;
}

interface ExprMatch {
  index: number;
  expr: string;
  end: number;
}

/**
 * Extracts all ${...} HTL expressions from a string, correctly handling
 * any depth of nested braces (e.g. '{{url}}' or '{0}/{1}' placeholders).
 */
export function extractExprs(str: string): ExprMatch[] {
  const results: ExprMatch[] = [];
  let i = 0;
  while (i < str.length) {
    const start = str.indexOf('${', i);
    if (start === -1) break;
    let depth = 0;
    let j = start;
    for (; j < str.length; j++) {
      if (str[j] === '{') depth++;
      else if (str[j] === '}') {
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
 * Converts all ${htlExpr} occurrences within an attribute value string,
 * while escaping literal backticks and bare $ signs.
 */
export function convertAttrValue(value: string): string {
  const parts: string[] = [];
  let last = 0;
  for (const { index, expr, end } of extractExprs(value)) {
    if (index > last) parts.push(escapeLiteral(value.slice(last, index)));
    parts.push(`\${_htlAttr(${convertExpr(expr)})}`);
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
    parts.push(`\${(${convertExpr(expr)}) ?? ''}`);
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
