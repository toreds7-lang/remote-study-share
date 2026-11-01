// Builds relay-bundle/: everything a spare Windows PC needs to be a 화면 공유 relay without
// installing anything. That is Node itself, the relay as one script, the mediasoup worker, and
// the batch files from relay/. Copy the folder to the PC (USB stick or shared folder) and run
// run-relay.bat there.

import fs from 'node:fs';
import path from 'node:path';
import { bundle } from './bundle.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const out = path.join(ROOT, 'relay-bundle');

if (process.platform !== 'win32') console.warn('The batch files are for Windows; on other systems run relay.mjs with node.');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out);

await bundle(path.join(ROOT, 'server', 'relay.ts'), path.join(out, 'relay.mjs'));

const worker = process.platform === 'win32' ? 'mediasoup-worker.exe' : 'mediasoup-worker';
fs.copyFileSync(path.join(ROOT, 'node_modules', 'mediasoup', 'worker', 'out', 'Release', worker), path.join(out, worker));
fs.copyFileSync(process.execPath, path.join(out, path.basename(process.execPath)));
fs.copyFileSync(path.join(ROOT, 'firewall.ps1'), path.join(out, 'firewall.ps1'));
for (const file of fs.readdirSync(path.join(ROOT, 'relay'))) fs.copyFileSync(path.join(ROOT, 'relay', file), path.join(out, file));

const mb = fs.readdirSync(out).reduce((n, f) => n + fs.statSync(path.join(out, f)).size, 0) / 1e6;
console.log(`relay-bundle/ is ready: ${mb.toFixed(0)} MB, Node ${process.version}.`);
console.log('Copy the folder to a spare PC and run firewall.bat once, then run-relay.bat. See README.txt in it.');
