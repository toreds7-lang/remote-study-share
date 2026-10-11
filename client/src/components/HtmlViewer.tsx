// A live HTML 교안: the page runs in a sandboxed frame laid out at HTML_FRAME size and
// scaled to fit, so it looks the same on every screen. The bridge script in the page
// (server/site-bridge.js) reports its slide and scroll position; ink is drawn on top.
import { useEffect, useRef, useState } from 'react';
import { HTML_FRAME, LIMITS, type DocInfo } from '../../../shared/protocol.ts';
import { onFrameState } from '../actions.ts';
import { api } from '../api.ts';
import { frameCommand, onFrameText, setFrame } from '../frame.ts';
import { useStore } from '../store.ts';
import { InkLayers, useBoxSize } from './InkLayers.tsx';

const PAD = 16;

/** Must match SANDBOX in server/site.ts. No allow-same-origin: the page gets an opaque origin. */
const SANDBOX = 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads';

// Signed site URLs last at least a day; fetch a fresh one after half of that.
const siteUrls = new Map<string, { url: Promise<string>; at: number }>();
function siteUrl(docId: string): Promise<string> {
  const cached = siteUrls.get(docId);
  if (cached && Date.now() - cached.at < 12 * 3600_000) return cached.url;
  const url = api.siteUrl(docId).then((r) => r.url);
  siteUrls.set(docId, { url, at: Date.now() });
  url.catch(() => siteUrls.delete(docId));
  return url;
}

const num = (v: unknown, max: number) => Math.min(max, Math.max(0, Math.round(Number(v) || 0)));

export function HtmlViewer({ doc }: { doc: DocInfo }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const box = useBoxSize(wrapRef);
  const view = useStore((s) => s.view);
  const frame = useStore((s) => (s.frame?.docId === doc.id ? s.frame : null));
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState(false);

  // Open the page at the slide being shown, so someone joining mid-class doesn't see slide 1 first.
  useEffect(() => {
    let cancelled = false;
    useStore.setState({ frame: null });
    siteUrl(doc.id)
      .then((url) => !cancelled && setSrc(url + (useStore.getState().view.html?.hash ?? '')))
      .catch(() => !cancelled && setError(true));
    return () => {
      cancelled = true;
      setFrame(doc.id, null);
    };
  }, [doc.id]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const win = frameRef.current?.contentWindow;
      const m = e.data as Record<string, unknown> | null;
      // The page is untrusted: accept only messages from our frame, with values checked.
      if (!win || e.source !== win || !m || typeof m.type !== 'string') return;
      if (m.type === 'ss:state') {
        setFrame(doc.id, win);
        onFrameState(
          {
            docId: doc.id,
            page: Math.max(1, num(m.page, LIMITS.htmlPages)),
            total: num(m.total, LIMITS.htmlPages),
            hash: String(m.hash ?? '').slice(0, 500),
            x: num(m.x, 1e7),
            y: num(m.y, 1e7),
          },
          m.user === true,
        );
      } else if (m.type === 'ss:text') onFrameText(Number(m.id), String(m.text ?? ''));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [doc.id]);

  // Move the frame to the position being viewed (the teacher's, while following).
  const ready = !!frame;
  useEffect(() => {
    if (!frame || view.docId !== doc.id) return;
    const want = view.html;
    if (want) {
      if (want.hash !== frame.hash || Math.abs(want.x - frame.x) > 1 || Math.abs(want.y - frame.y) > 1)
        frameCommand({ type: 'ss:nav', ...want });
    } else if (view.page !== frame.page) frameCommand({ type: 'ss:page', page: view.page });
    // Runs when the target changes or the frame first reports, not on every report.
  }, [view, ready]);

  const scale = Math.max(0.05, Math.min((box.w - PAD * 2) / HTML_FRAME.w, (box.h - PAD * 2) / HTML_FRAME.h));
  const w = HTML_FRAME.w * scale;
  const h = HTML_FRAME.h * scale;

  return (
    <div className="viewer" ref={wrapRef}>
      {error && <div className="viewer-empty">교안을 불러오지 못했어요.</div>}
      <div className="page html-page" style={{ width: w, height: h, visibility: box.w > 50 && !error ? 'visible' : 'hidden' }}>
        {src && (
          <iframe
            ref={frameRef}
            className="html-frame"
            src={src}
            title={doc.name}
            sandbox={SANDBOX}
            allow="autoplay; fullscreen"
            style={{ width: HTML_FRAME.w, height: HTML_FRAME.h, transform: `scale(${scale})` }}
          />
        )}
        {frame && (
          <InkLayers
            rendered={{ docId: doc.id, page: frame.page, w, h, ox: frame.x / HTML_FRAME.w, oy: frame.y / HTML_FRAME.h }}
            onWheel={(dx, dy) => frameCommand({ type: 'ss:scroll', dx: dx / scale, dy: dy / scale })}
          />
        )}
      </div>
    </div>
  );
}
