'use strict';
// Public builds never download or locate a private engine implicitly.
const fs = require('node:fs');
const path = require('node:path');
const { build, Platform, Arch } = require('electron-builder');
const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const args = process.argv.slice(2);
const platform = args.includes('--win') ? Platform.WINDOWS : args.includes('--linux') ? Platform.LINUX : args.includes('--mac') ? Platform.MAC : Platform.current();
const arch = args.includes('--arm64') ? 'arm64' : args.includes('--x64') ? 'x64' : process.arch;
const config = structuredClone(pkg.build);
const resources = process.env.WHALE_EXTERNAL_RESOURCES;
if (resources) {
  const base = path.resolve(resources);
  if (!fs.statSync(base).isDirectory()) throw new Error('External resources must be a directory');
  // Only these directories are eligible. Settings, sessions and keys are never copied.
  for (const name of ['engine', 'whisper']) {
    const source = path.join(base, name);
    if (fs.existsSync(source)) config.extraResources.push({ from: source, to: name, filter: ['**/*', '!**/*.pem', '!**/*.key', '!**/settings.json', '!**/auth.json', '!**/sessions/**', '!**/logs/**'] });
  }
}
if (process.env.WHALE_BUILD_OUTPUT) config.directories.output = path.resolve(process.env.WHALE_BUILD_OUTPUT);
if (process.env.WHALE_ELECTRON_DIST) config.electronDist = path.resolve(process.env.WHALE_ELECTRON_DIST);
const types = args.includes('--dir') ? ['dir'] : undefined;
build({ projectDir: root, targets: platform.createTarget(types, Arch[arch]), config, publish: 'never' }).catch(error => { console.error(error.message); process.exitCode = 1; });
