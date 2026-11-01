// Bundles a server entry point and the packages it imports into one ESM file that a bare node.exe
// runs without node_modules. Used for relay-bundle/ and the setup .exe.

import { build } from 'esbuild';

export async function bundle(entry: string, outfile: string, external: string[] = []) {
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external,
    // The bundled CommonJS packages (mediasoup, socket.io, express) still call require() and read __dirname.
    banner: {
      js: [
        "import { createRequire } from 'node:module';",
        "import { fileURLToPath } from 'node:url';",
        'const require = createRequire(import.meta.url);',
        'const __filename = fileURLToPath(import.meta.url);',
        "const __dirname = __filename.replace(/[\\\\/][^\\\\/]*$/, '');",
      ].join('\n'),
    },
    logLevel: 'warning',
  });
}
