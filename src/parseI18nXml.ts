import { parseDocument } from 'htmlparser2';

/**
 * Parses an AEM JCR i18n XML file into a plain string dictionary.
 *
 * Supported formats:
 *   1. JCR node-based (standard AEM format):
 *        <NodeName sling:key="..." sling:message="..."/>
 *   2. Simple entry-based (fallback):
 *        <entry key="...">value</entry>
 *
 * Uses htmlparser2 in XML mode — handles CDATA sections, XML comments,
 * multi-line attributes, and namespaced attributes correctly.
 * XML entities are decoded automatically by the parser for attribute values.
 * The optional {Type} prefix on sling:message values (e.g. "{String}Hello") is stripped.
 */
export function parseI18nXml(xmlContent: string): Record<string, string> {
  const doc = parseDocument(xmlContent, { xmlMode: true });
  const dict: Record<string, string> = {};

  function walk(nodes: any[]): void {
    for (const node of nodes) {
      if (node.type !== 'tag' && node.type !== 'script') {
        continue;
      }
      const key: string | undefined = node.attribs?.['sling:key'];
      const msg: string | undefined = node.attribs?.['sling:message'];
      if (key != null && msg != null) {
        dict[key] = msg.replace(/^\{[^}]+\}/, ''); // strip {String} prefix
      }
      if (node.children?.length) {
        walk(node.children);
      }
    }
  }
  walk(doc.children ?? []);

  if (Object.keys(dict).length === 0) {
    function walkEntry(nodes: any[]): void {
      for (const node of nodes) {
        if (
          (node.type === 'tag' || node.type === 'script') &&
          node.name === 'entry'
        ) {
          const entryKey: string | undefined = node.attribs?.key;
          if (entryKey != null) {
            const text = (node.children ?? [])
              .filter((c: any) => c.type === 'text')
              .map((c: any) => c.data as string)
              .join('');
            dict[entryKey] = decodeXmlEntities(text.trim());
          }
        }
        if (node.children?.length) walkEntry(node.children);
      }
    }
    walkEntry(doc.children ?? []);
  }

  return dict;
}

function decodeXmlEntities(s: string): string {
  return s
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)));
}

/**
 * Merges multiple i18n dictionaries. Arguments are in ascending priority order —
 * later arguments override earlier ones. Pass fallback dicts first, primary last.
 *
 *   mergeI18nDicts(enDict, esDict, esMxDict)
 *   // → es_MX keys win, es fills missing, en fills the rest
 */
export function mergeI18nDicts(...dicts: Record<string, string>[]): Record<string, string> {
  return Object.assign({}, ...dicts);
}

/**
 * Resolves a locale code into an ascending-priority chain for use with mergeI18nDicts.
 * 'en' is always the base. The primary locale is last (highest priority).
 * Supports simple, region, and extended BCP 47 subtags (language-script-region).
 *
 *   resolveLocaleChain('es_MX')       → ['en', 'es', 'es_MX']
 *   resolveLocaleChain('de')          → ['en', 'de']
 *   resolveLocaleChain('en')          → ['en']
 *   resolveLocaleChain('zh-Hant-TW')  → ['en', 'zh', 'zh_Hant', 'zh_Hant_TW']
 */
export function resolveLocaleChain(locale: string): string[] {
  // Normalise all hyphens to underscores (BCP 47 uses hyphens, AEM uses underscores).
  const parts = locale.replaceAll('-', '_').split('_');
  const chain: string[] = ['en'];
  let accumulated = '';
  for (const part of parts) {
    accumulated = accumulated ? `${accumulated}_${part}` : part;
    if (accumulated !== 'en') chain.push(accumulated);
  }
  return [...new Set(chain)];
}
