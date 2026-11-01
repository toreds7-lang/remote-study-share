// Builds release/StudyShare-Setup-<version>.exe: one file that installs StudyShare on a Windows PC,
// as the teacher's PC or as a 화면 공유 relay. Nothing has to be installed on that PC, nor here to
// build it: the app runs on a copy of Node, and the setup is compiled with the C# compiler that
// comes with Windows (.NET Framework 4).
//
//   npm run installer
//
// release/app/ is the folder as it is installed under Program Files. It keeps the project's
// layout (server/, dist/, node_modules/pdfjs-dist/), so server/config.ts finds everything.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { build as buildClient } from 'vite';
import { bundle } from '../server/bundle.ts';
import { makeIco } from './icon.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const HERE = import.meta.dirname;
const out = path.join(ROOT, 'release');
const app = path.join(out, 'app');
const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version: string };
const csc = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');

if (process.platform !== 'win32' || !fs.existsSync(csc)) {
  console.error(`The setup is built on Windows with ${csc}.`);
  process.exit(1);
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(app, 'server'), { recursive: true });

await buildClient({ configFile: path.join(ROOT, 'vite.config.ts'), logLevel: 'warn' });
fs.cpSync(path.join(ROOT, 'dist'), path.join(app, 'dist'), { recursive: true });
// Vite is only used by the dev server, which the installed app never starts.
await bundle(path.join(ROOT, 'server', 'index.ts'), path.join(app, 'server', 'server.mjs'), ['vite']);
await bundle(path.join(ROOT, 'server', 'relay.ts'), path.join(app, 'server', 'relay.mjs'));
for (const f of ['office-to-pdf.ps1', 'site-bridge.js']) fs.copyFileSync(path.join(ROOT, 'server', f), path.join(app, 'server', f));
for (const d of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  fs.cpSync(path.join(ROOT, 'node_modules', 'pdfjs-dist', d), path.join(app, 'node_modules', 'pdfjs-dist', d), { recursive: true });
}
fs.copyFileSync(process.execPath, path.join(app, 'node.exe'));
fs.copyFileSync(path.join(ROOT, 'node_modules', 'mediasoup', 'worker', 'out', 'Release', 'mediasoup-worker.exe'), path.join(app, 'mediasoup-worker.exe'));

// Text files with CRLF: cmd misreads labels in LF-only batch files.
const crlf = (text: string) => text.replace(/\r?\n/g, '\r\n');
for (const f of ['StudyShare.cmd', 'StudyShare-Relay.cmd', 'relay.example.txt']) {
  fs.writeFileSync(path.join(app, f), crlf(fs.readFileSync(path.join(HERE, f), 'utf8')));
}
// The settings a new teacher's PC starts with: .env.example under its own heading.
const env = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8').replace(/^#.*\r?\n/, '# StudyShare settings. Close the StudyShare window and open StudyShare again after changing them.\n');
fs.writeFileSync(path.join(app, 'env.example.txt'), crlf(env));
const ico = path.join(app, 'StudyShare.ico');
fs.writeFileSync(ico, makeIco());

// uninstall.exe is the same program without the payload, so it goes into the payload itself.
compile(path.join(app, 'uninstall.exe'), 'StudyShare Uninstall');
const payload = path.join(out, 'payload.zip');
fs.writeFileSync(payload, zip(app));
const setup = path.join(out, `StudyShare-Setup-${version}.exe`);
compile(setup, 'StudyShare Setup', payload);

const mb = (file: string) => (fs.statSync(file).size / 1e6).toFixed(0);
console.log(`\n  ${path.relative(ROOT, setup)} is ready: ${mb(setup)} MB, Node ${process.version}.`);
console.log('  Copy it to the PC (USB stick or shared folder) and run it there as an administrator.\n');

function compile(exe: string, title: string, resource?: string) {
  const info = path.join(out, 'Version.cs');
  fs.writeFileSync(
    info,
    [
      `[assembly: System.Reflection.AssemblyTitle("${title}")]`,
      '[assembly: System.Reflection.AssemblyProduct("StudyShare")]',
      `[assembly: System.Reflection.AssemblyFileVersion("${version.replace(/[^\d.]/g, '')}")]`,
      `[assembly: System.Reflection.AssemblyInformationalVersion("${version}")]`,
      `static partial class Setup { public const string Version = "${version}"; }`,
    ].join('\n'),
  );
  const refs = ['System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll', 'System.IO.Compression.dll', 'Microsoft.CSharp.dll'];
  execFileSync(
    csc,
    [
      '/nologo',
      '/noconfig',
      '/codepage:65001',
      '/target:winexe',
      '/platform:x64',
      '/optimize+',
      '/warnaserror+',
      `/out:${exe}`,
      `/win32icon:${ico}`,
      `/win32manifest:${path.join(HERE, 'setup.manifest')}`,
      ...refs.map((r) => `/reference:${r}`),
      ...(resource ? [`/resource:${resource},payload.zip`] : []),
      path.join(HERE, 'Setup.cs'),
      path.join(HERE, 'SetupForm.cs'),
      info,
    ],
    { stdio: 'inherit' },
  );
}

/** A ZIP of every file under dir, deflated (setup reads it with .NET's ZipArchive). */
function zip(dir: string): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const files = fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile());
  for (const e of files) {
    const file = path.join(e.parentPath, e.name);
    const name = Buffer.from(path.relative(dir, file).split(path.sep).join('/'));
    const data = fs.readFileSync(file);
    const packed = zlib.deflateRawSync(data, { level: 9 });
    const fields = (b: Buffer, at: number) => {
      b.writeUInt16LE(20, at); // version needed
      b.writeUInt16LE(0x0800, at + 2); // UTF-8 names
      b.writeUInt16LE(8, at + 4); // deflate
      b.writeUInt32LE(0x00210000, at + 6); // 1980-01-01 00:00, same for every build
      b.writeUInt32LE(zlib.crc32(data) >>> 0, at + 10);
      b.writeUInt32LE(packed.length, at + 14);
      b.writeUInt32LE(data.length, at + 18);
      b.writeUInt16LE(name.length, at + 22);
    };
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    fields(local, 4);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4); // version made by
    fields(entry, 6);
    entry.writeUInt32LE(offset, 42);
    parts.push(local, name, packed);
    central.push(entry, name);
    offset += local.length + name.length + packed.length;
  }
  const dirSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dirSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}
