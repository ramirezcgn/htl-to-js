#!/usr/bin/env node

import { transpile, generateDts } from './transpiler/index';
import { parseI18nXml, mergeI18nDicts } from './parseI18nXml';
import { glob } from 'glob';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);

if (!args.length || args.includes('--help') || args.includes('-h')) {
  console.log(`
htl-gen — transpile HTL templates to JS template string functions

Usage:
  htl-gen <glob>                              Transpile matching files once
  htl-gen --watch <glob>                      Watch and re-transpile on changes
  htl-gen --i18n <dict.xml> <glob>            Pre-load i18n dictionary from AEM XML
  htl-gen --i18n <primary.xml> --i18n <fallback.xml> <glob>
                                              Multiple locales: first = primary, rest = fallbacks

Examples:
  htl-gen "components/**/*.html"
  htl-gen accordion.html
  htl-gen --watch "src/**/*.html"
  htl-gen --i18n i18n/en.xml "src/**/*.html"
  htl-gen --i18n i18n/es_MX.xml --i18n i18n/es.xml --i18n i18n/en.xml "src/**/*.html"
`);
  process.exit(0);
}

const watchMode = args.includes('--watch') || args.includes('-w');

// Collect all --i18n paths in order. First = primary locale, rest = fallbacks.
const i18nPaths: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--i18n' && args[i + 1] && !args[i + 1].startsWith('-')) {
    i18nPaths.push(args[i + 1]);
    i++;
  }
}

const patternArg = args.find((a) => !a.startsWith('-') && !i18nPaths.includes(a));

if (!patternArg) {
  console.error('Error: no glob pattern provided.');
  process.exit(1);
}

let i18nDict: Record<string, string> | undefined;
if (i18nPaths.length) {
  try {
    const allDicts = i18nPaths.map((p) => parseI18nXml(fs.readFileSync(p, 'utf8')));
    // Primary (first) wins; merge fallbacks in ascending priority order so primary overrides all.
    i18nDict = allDicts.length > 1 ? mergeI18nDicts(...allDicts.slice(1).reverse(), allDicts[0]) : allDicts[0];
    const totalKeys = Object.keys(i18nDict).length;
    const paths = i18nPaths.map((p) => path.relative(process.cwd(), p)).join(', ');
    console.log(`i18n: loaded ${totalKeys} keys from [${paths}]`);
  } catch (err: any) {
    console.error(`Error loading i18n file: ${err.message}`);
    process.exit(1);
  }
}

const pattern: string = patternArg;

function processFile(file: string): void {
  try {
    const source = fs.readFileSync(file, 'utf8');
    const output = transpile(source, { filename: file, i18nDict });
    const outFile = file.replace(/\.html$/, '.template.js');
    const dtsFile = file.replace(/\.html$/, '.template.d.ts');
    fs.writeFileSync(outFile, output, 'utf8');
    fs.writeFileSync(dtsFile, generateDts(output), 'utf8');
    console.log(
      `✓  ${path.relative(process.cwd(), file)} → ${path.basename(outFile)}, ${path.basename(dtsFile)}`
    );
  } catch (err: any) {
    console.error(`✗  ${path.relative(process.cwd(), file)}: ${err.message}`);
  }
}

async function main(): Promise<void> {
  const files = await glob(pattern, { absolute: true });

  if (!files.length) {
    console.warn(`No files matched: ${pattern}`);
    process.exit(0);
  }

  for (const file of files) processFile(file);

  if (watchMode) {
    console.log(`\nWatching ${files.length} file(s) for changes…\n`);
    for (const file of files) {
      fs.watch(file, () => {
        console.log(`↻  ${path.relative(process.cwd(), file)} changed`);
        processFile(file);
      });
    }
  }
}

main(); // NOSONAR
