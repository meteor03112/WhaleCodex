'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
let failures = 0, count = 0;
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist', 'external-resources'].includes(entry.name)) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (/\.(?:js|cjs)$/.test(entry.name)) {
      count++;
      const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
      if (result.status !== 0) failures++;
    }
  }
}
walk(root);
const pkg = require('../package.json');
if (!fs.existsSync(path.join(root, pkg.main))) failures++;
console.log(`${count} JavaScript files checked; ${failures} failures.`);
process.exitCode = failures ? 1 : 0;
