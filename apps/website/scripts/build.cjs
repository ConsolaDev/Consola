const { cpSync, rmSync } = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const output = path.join(root, 'dist');
rmSync(output, { recursive: true, force: true });
cpSync(path.join(root, 'public'), output, { recursive: true });
