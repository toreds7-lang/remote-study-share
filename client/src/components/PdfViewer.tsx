import { useEffect, useRef, useState } from 'react';
import type { RenderTask } from 'pdfjs-dist';
import { loadPdf, renderPageToCanvas } from '../pdf.ts';
import { useStore } from '../store.ts';
import { InkLayers, useBoxSize, type Rendered } from './InkLayers.tsx';

const PAD = 16;

export function PdfViewer() {
  const view = useStore((s) => s.view);
  const rev = useStore((s) => s.docs.find((d) => d.id === s.view.docId)?.rev ?? 0);
  const isTeacher = useStore((s) => s.me?.role === 'teacher');
  const wrapRef = useRef<HTMLDivElement>(null);
  const pageCanvasRef = useRef<HTMLCanvasElement>(null);
  const box = useBoxSize(wrapRef);
  const [rendered, setRendered] = useState<Rendered | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const docId = view.docId;
    if (!docId || box.w < 50 || box.h < 50) return;
    let cancelled = false;
    let task: RenderTask | undefined;
    (async () => {
      const pdf = await loadPdf(docId);
      const pageNum = Math.min(Math.max(1, view.page), pdf.numPages);
      const page = await pdf.getPage(pageNum);
      if (cancelled) return;
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min((box.w - PAD * 2) / base.width, (box.h - PAD * 2) / base.height);
      // Render off-screen first so the previous page stays visible until the new one is ready.
      const r = await renderPageToCanvas(page, scale, window.devicePixelRatio || 1);
      task = r.task;
      await r.task.promise;
      const c = pageCanvasRef.current;
      if (cancelled || !c) return;
      c.width = r.canvas.width;
      c.height = r.canvas.height;
      c.getContext('2d')!.drawImage(r.canvas, 0, 0);
      setRendered({ docId, page: pageNum, w: base.width * scale, h: base.height * scale, ox: 0, oy: 0 });
      setError(null);
    })().catch((err: unknown) => {
      if (cancelled || (err as Error)?.name === 'RenderingCancelledException') return;
      console.error(err);
      setError('교안을 불러오지 못했어요.');
    });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [view.docId, view.page, rev, box.w, box.h]);

  return (
    <div className="viewer" ref={wrapRef}>
      {!view.docId && (
        <div className="viewer-empty">
          {isTeacher ? (
            <span>
              PDF·PPT·워드·이미지·HTML 파일을 여기에 끌어다 놓거나 <strong>교안 추가</strong>를 누르세요.
              <br />
              빈 판서를 만들거나 Ctrl+V로 캡처 이미지를 붙여 넣어도 돼요.
            </span>
          ) : (
            '강사가 아직 교안을 올리지 않았어요.'
          )}
        </div>
      )}
      {error && <div className="viewer-empty">{error}</div>}
      <div
        className="page"
        style={{
          width: rendered?.w ?? 0,
          height: rendered?.h ?? 0,
          visibility: view.docId && rendered && !error ? 'visible' : 'hidden',
        }}
      >
        <canvas ref={pageCanvasRef} className="page-canvas" style={{ width: rendered?.w, height: rendered?.h }} />
        {rendered && <InkLayers rendered={rendered} />}
      </div>
    </div>
  );
}
