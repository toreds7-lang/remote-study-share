import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  Camera,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  Crosshair,
  Download,
  Eraser,
  FilePlus2,
  Grid3x3,
  ImagePlus,
  Maximize,
  Minimize,
  Pencil,
  Plus,
  SquarePen,
  Trash,
  Type,
  Undo2,
  Upload,
} from 'lucide-react';
import type { Layer, Stroke } from '../../../shared/protocol.ts';
import { COLORS, LIMITS, PEN_SIZES } from '../../../shared/protocol.ts';
import { canUndo, clearPage, goTo, step, undo, useHistory } from '../actions.ts';
import { fileDownloadUrl, type Paper } from '../api.ts';
import { capturePage, exportPdfWithInk } from '../export.ts';
import {
  addBlankPage,
  addImagePages,
  addLectureFiles,
  createWhiteboard,
  deleteCurrentPage,
  lectureAccept,
} from '../lecture.ts';
import { ensureStrokes } from '../socket.ts';
import { markDownloaded, pageKey, setFollow, toast, useStore, writePref, type Tool } from '../store.ts';
import { HtmlViewer } from './HtmlViewer.tsx';
import { Menu } from './Menu.tsx';
import { Modal } from './Modal.tsx';
import { PdfViewer } from './PdfViewer.tsx';

export function LecturePane() {
  const paneRef = useRef<HTMLDivElement>(null);
  const viewDoc = useStore((s) => s.view.docId);
  const doc = useStore((s) => s.docs.find((d) => d.id === s.view.docId));
  const isTeacher = useStore((s) => s.me?.role === 'teacher');
  const [dropping, setDropping] = useState(false);
  const dragDepth = useRef(0);

  useEffect(() => {
    void ensureStrokes(viewDoc);
  }, [viewDoc]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, [contenteditable="true"]')) return;
      const s = useStore.getState();
      if (s.tab !== 'lecture') return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') step(1);
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') step(-1);
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && s.drawMode && s.view.docId) {
        undo(isTeacher ? 'teacher' : 'note', s.view.docId, s.view.page);
      } else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isTeacher]);

  // Teacher: Ctrl+V with a copied image or screenshot puts it on the next page.
  useEffect(() => {
    if (!isTeacher) return;
    const onPaste = (e: ClipboardEvent) => {
      if (useStore.getState().tab !== 'lecture') return;
      if ((e.target as HTMLElement).closest?.('input, textarea, [contenteditable="true"]')) return;
      const images = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
      if (!images.length) return;
      e.preventDefault();
      void addImagePages(images);
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [isTeacher]);

  // Teacher: files dropped on the 교안 area become new 교안.
  const carriesFiles = (e: React.DragEvent) => isTeacher && e.dataTransfer.types.includes('Files');
  return (
    <div
      className="lecture"
      ref={paneRef}
      onDragEnter={(e) => {
        if (!carriesFiles(e)) return;
        dragDepth.current++;
        setDropping(true);
      }}
      onDragOver={(e) => carriesFiles(e) && e.preventDefault()}
      onDragLeave={(e) => {
        if (carriesFiles(e) && --dragDepth.current <= 0) setDropping(false);
      }}
      onDrop={(e) => {
        if (!carriesFiles(e)) return;
        e.preventDefault();
        dragDepth.current = 0;
        setDropping(false);
        void addLectureFiles([...e.dataTransfer.files]);
      }}
    >
      <Toolbar paneRef={paneRef} />
      {doc?.kind === 'html' ? <HtmlViewer key={doc.id} doc={doc} /> : <PdfViewer />}
      {dropping && <div className="drop-overlay">놓으면 새 교안으로 올려요 · PDF·PPT·워드·엑셀·이미지·HTML·ZIP</div>}
    </div>
  );
}

function Toolbar({ paneRef }: { paneRef: React.RefObject<HTMLDivElement | null> }) {
  const isTeacher = useStore((s) => s.me?.role === 'teacher');
  const drawMode = useStore((s) => s.drawMode);
  const showTeacherInk = useStore((s) => s.showTeacherInk);
  const layer: Layer = isTeacher ? 'teacher' : 'note';

  return (
    <div className="toolbar">
      <div className="toolbar-group">
        <button
          className={`pill-btn ${drawMode ? 'active' : ''}`}
          onClick={() => useStore.setState({ drawMode: !drawMode })}
          title={isTeacher ? '판서 도구 (학생 화면에 실시간 표시)' : '내 필기 (나만 보여요)'}
        >
          <Pencil size={14} /> {isTeacher ? '판서' : '내 필기'}
          {drawMode && <span className="dot" />}
        </button>
        {drawMode && <DrawTools layer={layer} />}
        {!isTeacher && (
          <button
            className="text-btn"
            onClick={() => {
              useStore.setState({ showTeacherInk: !showTeacherInk });
              writePref('ss.showTeacherInk', !showTeacherInk);
            }}
            title="강사 판서 표시/숨기기"
          >
            강사 판서 {showTeacherInk ? 'ON' : 'OFF'}
          </button>
        )}
        <span className="sep" />
        {isTeacher && <DocControls />}
        <SaveButtons />
      </div>
      <div className="toolbar-group right">
        {isTeacher ? <LiveBadge /> : <FollowToggle />}
        <FullscreenButton paneRef={paneRef} />
        <PageNav />
      </div>
    </div>
  );
}

function DrawTools({ layer }: { layer: Layer }) {
  const tool = useStore((s) => s.tool);
  const color = useStore((s) => s.color);
  const sizeIdx = useStore((s) => s.sizeIdx);
  const view = useStore((s) => s.view);
  useHistory((h) => h.stacks); // re-render when undo history changes
  const hasStrokes = useStore((s) => (view.docId ? (s.strokes[layer][pageKey(view.docId, view.page)]?.length ?? 0) : 0) > 0);

  const tools: { id: Tool; icon: React.ReactNode; label: string }[] = [
    { id: 'pen', icon: <Pencil size={15} />, label: '펜' },
    { id: 'text', icon: <Type size={15} />, label: '텍스트' },
    { id: 'eraser', icon: <Eraser size={15} />, label: '지우개 (획 단위)' },
  ];
  if (layer === 'teacher') tools.push({ id: 'laser', icon: <Crosshair size={15} />, label: '레이저 포인터' });

  return (
    <>
      {tools.map((t) => (
        <button
          key={t.id}
          className={`icon-btn ${tool === t.id ? 'selected' : ''}`}
          title={t.label}
          aria-label={t.label}
          aria-pressed={tool === t.id}
          onClick={() => useStore.setState({ tool: t.id })}
        >
          {t.icon}
        </button>
      ))}
      <span className="sep thin" />
      {PEN_SIZES.map((size, i) => (
        <button
          key={size}
          className={`size-btn ${sizeIdx === i ? 'selected' : ''}`}
          title={['가늘게', '보통', '굵게'][i]}
          aria-label={['가늘게', '보통', '굵게'][i]}
          onClick={() => useStore.setState({ sizeIdx: i })}
        >
          <span style={{ width: 4 + i * 3, height: 4 + i * 3 }} />
        </button>
      ))}
      {COLORS.map((c) => (
        <button
          key={c}
          className={`color-btn ${color === c ? 'selected' : ''}`}
          style={{ '--swatch': c } as React.CSSProperties}
          title="색상"
          aria-label={`색상 ${c}`}
          onClick={() => useStore.setState({ color: c, tool: tool === 'eraser' || tool === 'laser' ? 'pen' : tool })}
        />
      ))}
      <span className="sep thin" />
      <button
        className="icon-btn"
        title="실행 취소 (Ctrl+Z)"
        aria-label="실행 취소"
        disabled={!canUndo(layer, view.docId, view.page)}
        onClick={() => view.docId && undo(layer, view.docId, view.page)}
      >
        <Undo2 size={15} />
      </button>
      <button
        className="icon-btn"
        title="이 페이지 필기 모두 지우기"
        aria-label="이 페이지 필기 모두 지우기"
        disabled={!hasStrokes}
        onClick={() => {
          if (view.docId && confirm(`${view.page}페이지의 ${layer === 'teacher' ? '판서' : '내 필기'}를 모두 지울까요?`))
            clearPage(layer, view.docId, view.page);
        }}
      >
        <Trash size={15} />
      </button>
    </>
  );
}

function DocControls() {
  const docs = useStore((s) => s.docs);
  const view = useStore((s) => s.view);
  const officeExts = useStore((s) => s.officeExts);
  const doc = docs.find((d) => d.id === view.docId);
  const fileRef = useRef<HTMLInputElement>(null);
  const imageRef = useRef<HTMLInputElement>(null);
  const status = useStore((s) => s.uploadStatus);
  const [boardOpen, setBoardOpen] = useState(false);
  const busy = status !== null;

  const picked = (input: HTMLInputElement, use: (files: File[]) => Promise<void>) => {
    const files = [...(input.files ?? [])];
    input.value = '';
    if (files.length) void use(files);
  };

  return (
    <>
      {docs.length > 0 && (
        <select
          className="doc-select"
          value={view.docId ?? ''}
          onChange={(e) => goTo(e.target.value, 1)}
          title="학생들에게 보여줄 교안"
        >
          {docs.map((d) => (
            <option key={d.id} value={d.id}>
              {d.kind === 'html' ? '🌐 ' : ''}
              {d.name}
            </option>
          ))}
        </select>
      )}
      <Menu
        title="교안 추가"
        button={<Plus size={16} />}
        items={[
          {
            icon: <Upload size={14} />,
            label: '파일 올리기 (PDF·PPT·이미지·HTML)',
            onClick: () => fileRef.current?.click(),
            disabled: busy,
          },
          { icon: <SquarePen size={14} />, label: '빈 판서 만들기', onClick: () => setBoardOpen(true) },
        ]}
        hint="여러 이미지는 한 교안으로 묶여요. HTML이 그림·스크립트 파일을 쓰면 폴더째 ZIP으로 올리세요."
      />
      {doc?.kind === 'pdf' && (
        <Menu
          title="페이지 넣기·삭제"
          button={<FilePlus2 size={15} />}
          items={[
            { icon: <FilePlus2 size={14} />, label: '빈 페이지 넣기', onClick: () => void addBlankPage('blank'), disabled: busy },
            { icon: <Grid3x3 size={14} />, label: '모눈 페이지 넣기', onClick: () => void addBlankPage('grid'), disabled: busy },
            {
              icon: <ImagePlus size={14} />,
              label: '이미지를 페이지로 넣기',
              onClick: () => imageRef.current?.click(),
              disabled: busy,
            },
            { icon: <Trash size={14} />, label: `${view.page}쪽 삭제`, onClick: () => void deleteCurrentPage(), danger: true },
          ]}
          hint={`새 페이지는 ${view.page}쪽 다음에 들어가요. 캡처한 이미지는 Ctrl+V로 바로 붙여 넣을 수 있어요.`}
        />
      )}
      {status && <span className="muted small status-text">{status}</span>}
      <input
        ref={fileRef}
        type="file"
        multiple
        accept={lectureAccept(officeExts)}
        hidden
        onChange={(e) => picked(e.target, addLectureFiles)}
      />
      <input
        ref={imageRef}
        type="file"
        multiple
        accept="image/*"
        hidden
        onChange={(e) => picked(e.target, addImagePages)}
      />
      {boardOpen && <WhiteboardDialog onClose={() => setBoardOpen(false)} />}
    </>
  );
}

const PAPERS: { id: Paper; label: string }[] = [
  { id: 'blank', label: '빈 종이' },
  { id: 'grid', label: '모눈' },
  { id: 'lines', label: '줄' },
];

function WhiteboardDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState(() => {
    const now = new Date().toLocaleString('ko-KR', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    return `판서 ${now}`;
  });
  const [pages, setPages] = useState('10');
  const [paper, setPaper] = useState<Paper>('blank');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const count = Math.min(LIMITS.whiteboardPages, Math.max(1, Math.round(Number(pages)) || 1));
      await createWhiteboard(name.trim() || '판서', count, paper);
      onClose();
    } catch (err) {
      toast((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal
      title="빈 판서 만들기"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            취소
          </button>
          <button className="btn primary" type="submit" form="board-new" disabled={busy}>
            {busy ? '만드는 중…' : '만들기'}
          </button>
        </>
      }
    >
      <form id="board-new" className="form" onSubmit={submit}>
        <label>
          이름
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={LIMITS.fileNameLen - 4} autoFocus />
        </label>
        <label>
          <span>
            쪽수 <span className="hint">나중에 페이지 메뉴에서 더 넣을 수 있어요</span>
          </span>
          <input
            type="number"
            min={1}
            max={LIMITS.whiteboardPages}
            value={pages}
            onChange={(e) => setPages(e.target.value)}
          />
        </label>
        <div className="paper-picks" role="radiogroup" aria-label="배경">
          {PAPERS.map((p) => (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={paper === p.id}
              className={`paper-pick ${paper === p.id ? 'active' : ''}`}
              onClick={() => setPaper(p.id)}
            >
              <span className={`paper-swatch ${p.id}`} />
              {p.label}
            </button>
          ))}
        </div>
      </form>
    </Modal>
  );
}

function SaveButtons() {
  const [busy, setBusy] = useState(false);
  const isHtml = useStore((s) => s.docs.find((d) => d.id === s.view.docId)?.kind === 'html');

  function visibleLayers(): { teacher: boolean; note: boolean } {
    const s = useStore.getState();
    const isTeacher = s.me?.role === 'teacher';
    return { teacher: isTeacher || s.showTeacherInk, note: !isTeacher };
  }

  async function capture() {
    const s = useStore.getState();
    const doc = s.docs.find((d) => d.id === s.view.docId);
    if (doc?.kind !== 'pdf') return;
    const key = pageKey(doc.id, s.view.page);
    const show = visibleLayers();
    const layers: Stroke[][] = [];
    if (show.teacher) layers.push(s.strokes.teacher[key] ?? []);
    if (show.note) layers.push(s.strokes.note[key] ?? []);
    setBusy(true);
    try {
      await capturePage(doc.id, doc.name, s.view.page, layers);
    } catch (err) {
      toast((err as Error).message || '캡처에 실패했어요.');
    } finally {
      setBusy(false);
    }
  }

  async function download() {
    const s = useStore.getState();
    const doc = s.docs.find((d) => d.id === s.view.docId);
    if (!doc) return;
    if (doc.kind === 'html') {
      // Ink can't be merged into a web page; this is the uploaded file, as in the 파일 tab.
      const a = document.createElement('a');
      a.href = fileDownloadUrl(doc.id);
      a.click();
      markDownloaded([doc.id]);
      return;
    }
    await ensureStrokes(doc.id);
    const show = visibleLayers();
    const byPage = new Map<number, Stroke[]>();
    for (const layer of ['teacher', 'note'] as const) {
      if (!show[layer]) continue;
      for (const [key, list] of Object.entries(useStore.getState().strokes[layer])) {
        if (!key.startsWith(`${doc.id}:`) || !list.length) continue;
        const page = Number(key.slice(doc.id.length + 1));
        byPage.set(page, [...(byPage.get(page) ?? []), ...list]);
      }
    }
    setBusy(true);
    toast(byPage.size ? `필기가 있는 ${byPage.size}쪽을 합쳐 PDF를 만드는 중…` : 'PDF를 내려받는 중…');
    try {
      await exportPdfWithInk(doc.id, doc.name, byPage);
    } catch (err) {
      console.error(err);
      toast('PDF를 만들지 못했어요.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        className="icon-btn"
        title={isHtml ? 'HTML 교안은 캡처할 수 없어요' : '현재 페이지 캡처 (PNG)'}
        aria-label="현재 페이지 캡처"
        disabled={busy || isHtml}
        onClick={capture}
      >
        <Camera size={15} />
      </button>
      <button
        className="icon-btn"
        title={isHtml ? '원본 파일 다운로드' : '필기 포함 PDF 다운로드'}
        aria-label={isHtml ? '원본 파일 다운로드' : '필기 포함 PDF 다운로드'}
        disabled={busy}
        onClick={download}
      >
        <Download size={15} />
      </button>
    </>
  );
}

function FollowToggle() {
  const follow = useStore((s) => s.follow);
  const teacher = useStore((s) => s.teacher);
  const view = useStore((s) => s.view);
  const away = teacher.docId !== view.docId || teacher.page !== view.page;
  return (
    <button
      className={`follow-btn ${follow ? 'on' : 'off'}`}
      onClick={() => setFollow(!follow)}
      title={follow ? '눌러서 혼자 보기로 전환' : '눌러서 강사 화면 따라가기'}
    >
      {follow ? '강사 화면 따라가기 중' : `혼자 보기${away && teacher.docId ? ` · 강사 p.${teacher.page}` : ''}`}
    </button>
  );
}

function LiveBadge() {
  const students = useStore((s) => s.online.filter((u) => u.role === 'student').length);
  return (
    <span className="follow-btn on static" title="학생들이 이 화면을 따라오고 있어요">
      학생 화면 송출 중 · {students}명
    </span>
  );
}

function FullscreenButton({ paneRef }: { paneRef: React.RefObject<HTMLDivElement | null> }) {
  const [full, setFull] = useState(false);
  useEffect(() => {
    const onChange = () => setFull(document.fullscreenElement === paneRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, [paneRef]);
  return (
    <button
      className="icon-btn"
      title={full ? '전체 화면 종료' : '전체 화면'}
      aria-label={full ? '전체 화면 종료' : '전체 화면'}
      onClick={() => {
        if (document.fullscreenElement) void document.exitFullscreen();
        else void paneRef.current?.requestFullscreen?.();
      }}
    >
      {full ? <Minimize size={15} /> : <Maximize size={15} />}
    </button>
  );
}

function PageNav() {
  const view = useStore((s) => s.view);
  const isHtml = useStore((s) => s.docs.find((d) => d.id === s.view.docId)?.kind === 'html');
  // An HTML 교안 reports its own slide count (0 if unknown, e.g. a scrolling page).
  const total = useStore((s) => {
    const doc = s.docs.find((d) => d.id === s.view.docId);
    if (doc?.kind !== 'html') return doc?.pages ?? 0;
    return s.frame?.docId === doc.id ? s.frame.total : 0;
  });
  const [draft, setDraft] = useState(String(view.page));
  useEffect(() => setDraft(String(view.page)), [view.page]);
  const disabled = !view.docId;
  // Without a known slide count, "next" on an HTML page scrolls down a screen.
  const atEnd = total > 0 ? view.page >= total : !isHtml;

  return (
    <div className="page-nav">
      <button className="icon-btn" title="첫 페이지" aria-label="첫 페이지" disabled={disabled || view.page <= 1} onClick={() => view.docId && goTo(view.docId, 1)}>
        <ChevronsLeft size={16} />
      </button>
      <button
        className="icon-btn"
        title="이전 페이지 (←)"
        aria-label="이전 페이지"
        disabled={disabled || (view.page <= 1 && !isHtml)}
        onClick={() => step(-1)}
      >
        <ChevronLeft size={16} />
      </button>
      <input
        className="page-input"
        value={draft}
        disabled={disabled}
        inputMode="numeric"
        aria-label="페이지 번호"
        onChange={(e) => setDraft(e.target.value.replace(/\D/g, ''))}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && view.docId) {
            goTo(view.docId, Number(draft) || 1);
            (e.target as HTMLInputElement).blur();
          }
        }}
        onBlur={() => setDraft(String(view.page))}
      />
      <span className="muted small">/ {total || '-'}</span>
      <button className="icon-btn" title="다음 페이지 (→)" aria-label="다음 페이지" disabled={disabled || atEnd} onClick={() => step(1)}>
        <ChevronRight size={16} />
      </button>
    </div>
  );
}
