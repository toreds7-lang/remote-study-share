import { createServer } from 'node:http';
import path from 'node:path';
import express from 'express';
import { Server } from 'socket.io';
import { createApi } from './api.ts';
import { config, ROOT } from './config.ts';
import { officeConverters } from './convert.ts';
import { setupRealtime } from './realtime.ts';
import { screenSummary, serverUrls, setupScreen } from './screen.ts';

const app = express();
const httpServer = createServer(app);

app.disable('x-powered-by');
if (config.trustProxy) app.set('trust proxy', 1);

const io = new Server(httpServer, {
  maxHttpBufferSize: 2e6,
  // Vite's HMR WebSocket shares this HTTP server in dev; don't kill its upgrade requests.
  destroyUpgrade: config.prod,
});
setupRealtime(io);
await setupScreen(io);

app.use('/api', createApi());

// pdf.js runtime assets (CJK character maps, standard fonts, image decoders).
const pdfjsDir = path.join(ROOT, 'node_modules', 'pdfjs-dist');
for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  app.use(`/pdfjs/${dir}`, express.static(path.join(pdfjsDir, dir), { maxAge: '7d', immutable: true }));
}

if (config.prod) {
  const dist = path.join(ROOT, 'dist');
  app.use(express.static(dist, { index: false, maxAge: '1h' }));
  app.get('/{*path}', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
} else {
  const { createServer: createVite } = await import('vite');
  const vite = await createVite({
    configFile: path.join(ROOT, 'vite.config.ts'),
    server: { middlewareMode: { server: httpServer }, ws: { server: httpServer } },
    appType: 'spa',
  });
  app.use(vite.middlewares);
}

httpServer.listen(config.port, config.host, () => {
  console.log(`\n  Study Share ${config.prod ? '(production)' : '(dev)'} running`);
  console.log(`  Local:   http://localhost:${config.port}`);
  // The real network card first; virtual adapters (WSL, Hyper-V, VPN) last.
  for (const url of serverUrls()) console.log(`  Network: ${url}`);
  console.log(`  AI helper: ${config.openaiKey ? `on (${config.llmModel})` : 'off (set OPENAI_API_KEY)'}`);
  console.log(`  Office → 교안: ${officeConverters || 'off (install LibreOffice, or Microsoft Office on Windows)'}`);
  console.log(`  화면 공유: ${screenSummary()}\n`);
});
