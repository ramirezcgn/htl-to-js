/**
 * Parses an AEM JCR i18n XML file into a plain string dictionary.
 *
 * Supported formats:
 *   1. JCR node-based (standard AEM format):
 *        <NodeName sling:key="..." sling:message="..."/>
 *   2. Simple entry-based (fallback):
 *        <entry key="...">value</entry>
 *
 * XML entities (&amp; &lt; &gt; &quot; &apos;) are decoded in both keys and values.
 * The optional {Type} prefix on sling:message values (e.g. "{String}Hello") is stripped.
 */
export function parseI18nXml(xmlContent: string): Record<string, string> {
  const dict: Record<string, string> = {};

  // Format 1: JCR self-closing MessageEntry nodes
  for (const m of xmlContent.matchAll(/<[\w:]+(\s[\s\S]*?)\/>/g)) {
    const attrs = m[1];
    const keyMatch = /\bsling:key="([^"]*)"/.exec(attrs);
    const msgMatch = /\bsling:message="([^"]*)"/.exec(attrs);
    if (keyMatch && msgMatch) {
      const rawMsg = msgMatch[1].replace(/^\{[^}]+\}/, ''); // strip {String} prefix
      dict[decodeXmlEntities(keyMatch[1])] = decodeXmlEntities(rawMsg);
    }
  }

  // Format 2: <entry key="...">value</entry> (fallback when format 1 yields nothing)
  if (Object.keys(dict).length === 0) {
    for (const m of xmlContent.matchAll(/<entry\s+key="([^"]*)">([\s\S]*?)<\/entry>/g)) {
      dict[decodeXmlEntities(m[1])] = decodeXmlEntities(m[2].trim());
    }
  }

  return dict;
}

function decodeXmlEntities(s: string): string {
  return s
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'");
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
 *
 *   resolveLocaleChain('es_MX') → ['en', 'es', 'es_MX']
 *   resolveLocaleChain('de')    → ['en', 'de']
 *   resolveLocaleChain('en')    → ['en']
 */
export function resolveLocaleChain(locale: string): string[] {
  const normalised = locale.replace('-', '_');
  const parts = normalised.split('_');
  const chain: string[] = ['en'];
  if (parts[0] !== 'en') chain.push(parts[0]);
  if (parts.length > 1) chain.push(normalised);
  return [...new Set(chain)];
}
