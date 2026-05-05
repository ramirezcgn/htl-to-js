#!/usr/bin/env node

import { transpile, generateDts } from './transpiler/index';
import { parseI18nXml } from './parseI18nXml';
import { glob } from 'glob';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);

if (!args.length || args.includes('--help') || args.includes('-h')) {
  console.log(`
htl-gen — transpile HTL templates to JS template string functions

Usage:
  htl-gen <glob>                       Transpile matching files once
  htl-gen --watch <glob>               Watch and re-transpile on changes
  htl-gen --i18n <dict.xml> <glob>     Pre-load i18n dictionary from AEM XML

Examples:
  htl-gen "components/**/*.html"
  htl-gen accordion.html
  htl-gen --watch "src/**/*.html"
  htl-gen --i18n i18n/en.xml "src/**/*.html"
`);
  process.exit(0);
}

const watchMode = args.includes('--watch') || args.includes('-w');
const i18nFlagIdx = args.indexOf('--i18n');
const i18nXmlPath = i18nFlagIdx === -1 ? undefined : args[i18nFlagIdx + 1];
const patternArg = args.find((a) => !a.startsWith('-') && a !== i18nXmlPath);

if (!patternArg) {
  console.error('Error: no glob pattern provided.');
  process.exit(1);
}

let i18nDict: Record<string, string> | undefined;
if (i18nXmlPath) {
  try {
    const xmlContent = fs.readFileSync(i18nXmlPath, 'utf8');
    i18nDict = parseI18nXml(xmlContent);
    console.log(`i18n: loaded ${Object.keys(i18nDict).length} keys from ${path.relative(process.cwd(), i18nXmlPath)}`);
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
