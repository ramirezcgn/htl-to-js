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
