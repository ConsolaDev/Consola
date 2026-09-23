#!/usr/bin/env node
/**
 * Copy conductor template files into dist, where tsc will not.
 *
 * tsc emits only TypeScript output; the .tmpl files must still ship, because
 * the packaged app (electron-builder `files: dist/**`) reads them at runtime.
 */
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '../src/main/conductor/templates');
const dest = path.join(__dirname, '../dist/main/main/conductor/templates');

fs.mkdirSync(dest, { recursive: true });
for (const entry of fs.readdirSync(src)) {
    fs.copyFileSync(path.join(src, entry), path.join(dest, entry));
}
console.log(`Copied ${fs.readdirSync(src).length} conductor templates to ${dest}`);
