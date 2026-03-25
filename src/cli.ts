#!/usr/bin/env node

import { transpile } from './transpiler/index';
import { glob } from 'glob';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);

if (!args.length || args.includes('--help') || args.includes('-h')) {
  console.log(`
htl-gen — transpile HTL templates to JS template string functions

Usage:
  htl-gen <glob>            Transpile matching files once
  htl-gen --watch <glob>    Watch and re-transpile on changes

Examples:
  htl-gen "components/**/*.html"
  htl-gen accordion.html
  htl-gen --watch "src/**/*.html"
`);
  process.exit(0);
}

const watchMode = args.includes('--watch') || args.includes('-w');
const patternArg = args.find(a => !a.startsWith('-'));

if (!patternArg) {
  console.error('Error: no glob pattern provided.');
  process.exit(1);
}

const pattern: string = patternArg;

function processFile(file: string): void {
  try {
    const source = fs.readFileSync(file, 'utf8');
    const output = transpile(source, { filename: file });
    const outFile = file.replace(/\.html$/, '.template.js');
    fs.writeFileSync(outFile, output, 'utf8');
    console.log(`✓  ${path.relative(process.cwd(), file)} → ${path.basename(outFile)}`);
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
