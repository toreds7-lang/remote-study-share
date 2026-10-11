import { useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from 'react';
import {
  Check,
  Download,
  Ellipsis,
  Eye,
  EyeOff,
  FolderDown,
  LayoutGrid,
  List,
  Pencil,
  Plus,
  Presentation,
  Trash,
  Upload,
  Users,
  X,
} from 'lucide-react';
import { canLecture, fileExt, fileKind, previewKind, type FileKind } from '../../../shared/files.ts';
import { LIMITS, type FileDownloads, type FileInfo } from '../../../shared/protocol.ts';
import { goTo } from '../actions.ts';
import { api, fileDownloadUrl, fileViewUrl, uploadFile, zipUrl } from '../api.ts';
import { forgetPdf } from '../pdf.ts';
import { markDownloaded, readPref, setTab, toast, useStore, writePref } from '../store.ts';
import { dateGroup, formatSize, timeAgo } from '../util.ts';
import { LiteMarkdown } from './LiteMarkdown.tsx';
import { Modal } from './Modal.tsx';

const FILTERS: { id: string; label: string; kinds: FileKind[] | null }[] = [
  { id: 'all', label: '전체', kinds: null },
  { id: 'image', label: '이미지', kinds: ['image'] },
  { id: 'pdf', label: 'PDF', kinds: ['pdf'] },
  { id: 'notebook', label: '노트북', kinds: ['notebook'] },
  { id: 'code', label: '코드·데이터', kinds: ['code', 'archive'] },
  { id: 'doc', label: '문서', kinds: ['doc'] },
];

const BADGE_COLOR: Record<FileKind, string> = {
  image: '#12a36f',
  pdf: '#e5484d',
  notebook: '#8e4ec6',
  code: '#3e63dd',
  doc: '#0d8fc4',
  archive: '#f0a00c',
  other: '#8b8d98',
};

const DEFAULT_TAGS = ['추가자료', '실습', '정답'];

type Dialog =
  | { type: 'upload'; files: File[] }
  | { type: 'preview' | 'stats' | 'edit'; file: FileInfo };

/** What rows and cards need from the pane. */
interface Ctx {
  isTeacher: boolean;
  downloaded: Record<string, true>;
  open: (f: FileInfo) => void;
  onDownload: (ids: string[]) => void;
  show: (d: Dialog) => void;
  filterTag: (tag: string) => void;
}

export function FilesPane() {
  const files = useStore((s) => s.files);
  const isTeacher = useStore((s) => s.me?.role === 'teacher');
  const downloaded = useStore((s) => s.myDownloads);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [view, setView] = useState<'list' | 'grid'>(() => readPref('ss.filesView', 'list'));
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const picker = useRef<HTMLInputElement>(null);

  const shown = useMemo(() => {
    const kinds = FILTERS.find((f) => f.id === filter)?.kinds;
    const q = query.trim().toLowerCase();
    return files.filter((f) => {
      if (kinds && !kinds.includes(fileKind(f.name))) return false;
      if (!q) return true;
      if (q.startsWith('#')) {
        const tag = q.slice(1).trim();
        return !tag || f.tag?.toLowerCase() === tag;
      }
      return [f.name, f.tag ?? '', f.uploader ?? ''].some((s) => s.toLowerCase().includes(q));
    });
  }, [files, filter, query]);

  // The server sends files newest first, so each date section is one contiguous run.
  const groups = useMemo(() => {
    const now = new Date();
    const out: { label: string; files: FileInfo[] }[] = [];
    for (const f of shown) {
      const label = dateGroup(f.uploadedAt, now);
      if (out.at(-1)?.label !== label) out.push({ label, files: [] });
      out.at(-1)!.files.push(f);
    }
    return out;
  }, [shown]);

  const tags = useMemo(
    () => [...new Set([...files.map((f) => f.tag).filter((t): t is string => !!t), ...DEFAULT_TAGS])].slice(0, 8),
    [files],
  );

  const ctx: Ctx = {
    isTeacher,
    downloaded,
    open(f) {
      const kind = previewKind(f.name);
      if (kind === 'pdf') window.open(fileViewUrl(f.id), '_blank', 'noopener');
      else if (kind) setDialog({ type: 'preview', file: f });
    },
    onDownload: (ids) => !isTeacher && markDownloaded(ids),
    show: setDialog,
    filterTag: (tag) => setQuery(`#${tag}`),
  };

  function changeView(v: 'list' | 'grid') {
    setView(v);
    writePref('ss.filesView', v);
  }

  const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes('Files');
  const dropProps = isTeacher
    ? {
        onDragEnter: (e: DragEvent) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          dragDepth.current++;
          setDragging(true);
        },
        onDragOver: (e: DragEvent) => hasFiles(e) && e.preventDefault(),
        onDragLeave: () => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (!dragDepth.current) setDragging(false);
        },
        onDrop: (e: DragEvent) => {
          e.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          if (e.dataTransfer.files.length) setDialog({ type: 'upload', files: [...e.dataTransfer.files] });
        },
      }
    : {};

  return (
    <>
      <div className="files-wrap" {...dropProps}>
        <div className="files-page">
          <div className="files-head">
            <h2 className="files-title">
              공유 파일 <span className="files-count">{files.length}개</span>
            </h2>
            <input
              className="files-search"
              type="search"
              placeholder="파일 검색..."
              aria-label="파일 검색"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <span className="push-right" />
            {shown.length > 1 && (
              <a
                className="btn"
                href={zipUrl(shown.map((f) => f.id))}
                onClick={() => ctx.onDownload(shown.map((f) => f.id))}
                title={`지금 보이는 ${shown.length}개 파일을 ZIP 하나로 받아요`}
              >
                <FolderDown size={15} /> 모두 받기
              </a>
            )}
            {isTeacher && (
              <button className="btn primary" onClick={() => picker.current?.click()}>
                <Upload size={15} /> 파일 올리기
              </button>
            )}
            <div className="view-toggle" role="group" aria-label="보기 방식">
              <button
                className={`icon-btn bordered ${view === 'list' ? 'selected' : ''}`}
                aria-pressed={view === 'list'}
                title="목록으로 보기"
                onClick={() => changeView('list')}
              >
                <List size={16} />
              </button>
              <button
                className={`icon-btn bordered ${view === 'grid' ? 'selected' : ''}`}
                aria-pressed={view === 'grid'}
                title="카드로 보기"
                onClick={() => changeView('grid')}
              >
                <LayoutGrid size={16} />
              </button>
            </div>
            <input
              ref={picker}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files?.length) setDialog({ type: 'upload', files: [...e.target.files] });
                e.target.value = '';
              }}
            />
          </div>

          <div className="files-chips" role="group" aria-label="파일 종류">
            {FILTERS.map((f) => (
              <button key={f.id} className={`chip ${filter === f.id ? 'active' : ''}`} onClick={() => setFilter(f.id)}>
                {f.label}
              </button>
            ))}
          </div>

          {files.length === 0 ? (
            <div className="files-empty">
              {isTeacher ? (
                <>
                  <Upload size={28} />
                  <p>
                    아직 공유한 파일이 없어요.
                    <br />
                    파일을 이 화면에 끌어다 놓거나 <strong>파일 올리기</strong>를 누르세요.
                  </p>
                </>
              ) : (
                <p>아직 공유된 파일이 없어요.</p>
              )}
            </div>
          ) : shown.length === 0 ? (
            <div className="files-empty">
              <p>조건에 맞는 파일이 없어요.</p>
            </div>
          ) : (
            groups.map((g) => (
              <section key={g.label} className="files-group">
                <h3>{g.label}</h3>
                {view === 'list' ? (
                  <ul className="file-rows">
                    {g.files.map((f) => (
                      <FileRow key={f.id} f={f} ctx={ctx} />
                    ))}
                  </ul>
                ) : (
                  <div className="file-grid">
                    {g.files.map((f) => (
                      <FileCard key={f.id} f={f} ctx={ctx} />
                    ))}
                  </div>
                )}
              </section>
            ))
          )}
        </div>
        {dragging && <div className="drop-overlay">여기에 놓으면 업로드할 수 있어요</div>}
      </div>

      {dialog?.type === 'upload' && <UploadDialog initial={dialog.files} tags={tags} onClose={() => setDialog(null)} />}
      {dialog?.type === 'preview' && <PreviewDialog f={dialog.file} ctx={ctx} onClose={() => setDialog(null)} />}
      {dialog?.type === 'stats' && <StatsDialog f={dialog.file} onClose={() => setDialog(null)} />}
      {dialog?.type === 'edit' && <EditDialog f={dialog.file} tags={tags} onClose={() => setDialog(null)} />}
    </>
  );
}

// ---- rows and cards ----

function FileBadge({ name }: { name: string }) {
  const kind = fileKind(name);
  const label = kind === 'image' ? 'IMG' : fileExt(name).slice(0, 5).toUpperCase() || 'FILE';
  return (
    <span className="file-badge" style={{ background: BADGE_COLOR[kind] }} aria-hidden>
      {label}
    </span>
  );
}

/** Clicking the name previews the file when the browser can show it, otherwise downloads it. */
function FileName({ f, ctx }: { f: FileInfo; ctx: Ctx }) {
  if (!previewKind(f.name)) {
    return (
      <a className="file-name" href={fileDownloadUrl(f.id)} onClick={() => ctx.onDownload([f.id])} title={`${f.name} · 다운로드`}>
        {f.name}
      </a>
    );
  }
  return (
    <button className="file-name" onClick={() => ctx.open(f)} title={`${f.name} · 미리보기`}>
      {f.name}
    </button>
  );
}

function openInLecture(docId: string) {
  // Re-opening the document already on screen must not jump back to page 1.
  if (useStore.getState().view.docId !== docId) goTo(docId, 1);
  setTab('lecture');
}

function FileFlags({ f, ctx }: { f: FileInfo; ctx: Ctx }) {
  return (
    <span className="file-flags">
      {f.isDoc && (
        <button
          className="tag ok link"
          onClick={() => openInLecture(f.id)}
          title={ctx.isTeacher ? '교안 탭에서 열기 (학생 화면도 함께 이동해요)' : '교안 탭에서 열기'}
        >
          <Presentation size={11} /> 교안
        </button>
      )}
      {f.hidden && (
        <span className="tag" title="학생에게 보이지 않아요">
          <EyeOff size={11} /> 숨김
        </span>
      )}
      {!ctx.isTeacher && ctx.downloaded[f.id] && (
        <span className="tag" title="이미 받은 파일이에요">
          <Check size={11} /> 받음
        </span>
      )}
    </span>
  );
}

function StatButton({ f, ctx }: { f: FileInfo; ctx: Ctx }) {
  return (
    <button className="file-stat" onClick={() => ctx.show({ type: 'stats', file: f })} title="다운로드한 학생 보기">
      <Users size={12} /> {f.downloads ?? 0}명
    </button>
  );
}

function FileRow({ f, ctx }: { f: FileInfo; ctx: Ctx }) {
  return (
    <li className={`file-row ${f.hidden ? 'is-hidden' : ''}`}>
      <FileBadge name={f.name} />
      <div className="file-main">
        <FileName f={f} ctx={ctx} />
        <FileFlags f={f} ctx={ctx} />
      </div>
      <span className="file-col-tag">
        {f.tag ? (
          <button className="file-tag" onClick={() => ctx.filterTag(f.tag!)} title="이 태그만 보기">
            # {f.tag}
          </button>
        ) : (
          '전체'
        )}
      </span>
      <span className="file-col-uploader">{f.uploader}</span>
      <span className="file-col-size mono">{formatSize(f.size)}</span>
      {ctx.isTeacher && <StatButton f={f} ctx={ctx} />}
      <a
        className="icon-btn bordered"
        href={fileDownloadUrl(f.id)}
        onClick={() => ctx.onDownload([f.id])}
        title="다운로드"
        aria-label={`${f.name} 다운로드`}
      >
        <Download size={15} />
      </a>
      {ctx.isTeacher && <FileMenu f={f} ctx={ctx} />}
    </li>
  );
}

function FileCard({ f, ctx }: { f: FileInfo; ctx: Ctx }) {
  return (
    <div className={`file-card ${f.hidden ? 'is-hidden' : ''}`}>
      <div className="file-card-top">
        <FileBadge name={f.name} />
        {ctx.isTeacher && <FileMenu f={f} ctx={ctx} />}
      </div>
      <FileName f={f} ctx={ctx} />
      <div className="file-card-meta">
        {formatSize(f.size)}
        {f.tag && ` · ${f.tag}`}
      </div>
      <div className="file-card-flags">
        <FileFlags f={f} ctx={ctx} />
        {ctx.isTeacher && <StatButton f={f} ctx={ctx} />}
      </div>
      <a
        className="btn small file-card-dl"
        href={fileDownloadUrl(f.id)}
        onClick={() => ctx.onDownload([f.id])}
        title="다운로드"
        aria-label={`${f.name} 다운로드`}
      >
        <Download size={14} />
      </a>
    </div>
  );
}

// ---- teacher actions ----

async function attempt(fn: () => Promise<unknown>, done: string) {
  try {
    await fn();
    toast(done);
  } catch (err) {
    toast((err as Error).message);
  }
}

function FileMenu({ f, ctx }: { f: FileInfo; ctx: Ctx }) {
  const officeExts = useStore((s) => s.officeExts);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const item = (fn: () => unknown) => () => {
    setOpen(false);
    void fn();
  };

  async function remove() {
    const warn = f.isDoc ? '\n교안으로 쓰던 파일이라 판서와 학생 필기도 함께 삭제돼요.' : '';
    if (!confirm(`‘${f.name}’을(를) 삭제할까요?${warn}`)) return;
    await attempt(async () => {
      await api.deleteFile(f.id);
      if (f.isDoc) forgetPdf(f.id);
    }, '삭제했어요.');
  }

  return (
    <div className="menu-wrap" ref={ref}>
      <button
        className="icon-btn"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="더 보기"
        aria-label={`${f.name} 메뉴`}
      >
        <Ellipsis size={16} />
      </button>
      {open && (
        <div className="menu" role="menu">
          <button role="menuitem" onClick={item(() => ctx.show({ type: 'edit', file: f }))}>
            <Pencil size={14} /> 이름·태그 수정
          </button>
          {!f.isDoc && (
            <button
              role="menuitem"
              onClick={item(() =>
                attempt(
                  () => api.updateFile(f.id, { hidden: !f.hidden }),
                  f.hidden ? '학생에게 공개했어요.' : '학생에게 숨겼어요.',
                ),
              )}
            >
              {f.hidden ? <Eye size={14} /> : <EyeOff size={14} />} {f.hidden ? '학생에게 공개' : '학생에게 숨기기'}
            </button>
          )}
          {!f.isDoc && canLecture(f.name, officeExts) && (
            <button
              role="menuitem"
              onClick={item(() => attempt(() => api.makeLecture(f.id), '교안으로 등록했어요. 교안 탭에서 띄울 수 있어요.'))}
            >
              <Presentation size={14} /> 교안으로 등록
            </button>
          )}
          <button role="menuitem" className="danger" onClick={item(remove)}>
            <Trash size={14} /> 삭제
          </button>
        </div>
      )}
    </div>
  );
}

function TagField({ value, onChange, tags }: { value: string; onChange: (v: string) => void; tags: string[] }) {
  return (
    <div className="tag-field">
      <label>
        태그 <span className="hint">선택 · 비워 두면 ‘전체’로 표시돼요</span>
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          maxLength={LIMITS.tagLen + 1}
          placeholder="예: 추가자료"
        />
      </label>
      <div className="tag-picks">
        {tags.map((t) => (
          <button
            key={t}
            type="button"
            className={`chip ${value.replace(/^#/, '').trim() === t ? 'active' : ''}`}
            onClick={() => onChange(value === t ? '' : t)}
          >
            # {t}
          </button>
        ))}
      </div>
    </div>
  );
}

interface UploadItem {
  file: File;
  status: 'wait' | 'up' | 'done' | 'error';
  progress: number;
  error?: string;
}

function UploadDialog({ initial, tags, onClose }: { initial: File[]; tags: string[]; onClose: () => void }) {
  const maxMb = useStore((s) => s.maxUploadMb);
  const officeExts = useStore((s) => s.officeExts);
  const [items, setItems] = useState<UploadItem[]>(() => initial.map((file) => ({ file, status: 'wait', progress: 0 })));
  const [tag, setTag] = useState('');
  const [publish, setPublish] = useState(true);
  const [asDoc, setAsDoc] = useState(false);
  const [running, setRunning] = useState(false);
  const [over, setOver] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

  const add = (files: File[]) =>
    setItems((list) => [...list, ...files.map((file): UploadItem => ({ file, status: 'wait', progress: 0 }))]);
  const update = (i: number, patch: Partial<UploadItem>) =>
    setItems((list) => list.map((it, j) => (j === i ? { ...it, ...patch } : it)));

  // While the dialog is open, files dropped anywhere on the page are added to it.
  useEffect(() => {
    const onOver = (e: globalThis.DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      setOver(true);
    };
    const onLeave = (e: globalThis.DragEvent) => !e.relatedTarget && setOver(false);
    const onDrop = (e: globalThis.DragEvent) => {
      if (!e.dataTransfer?.files.length) return;
      e.preventDefault();
      setOver(false);
      add([...e.dataTransfer.files]);
    };
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  const hasLecture = items.some((it) => canLecture(it.file.name, officeExts));
  const todo = items.filter((it) => it.status !== 'done').length;

  async function start() {
    setRunning(true);
    let failed = 0;
    let done = 0;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.status === 'done') continue;
      if (it.file.size > maxMb * 1024 * 1024) {
        update(i, { status: 'error', error: `파일이 너무 커요. (최대 ${maxMb}MB)` });
        failed++;
        continue;
      }
      update(i, { status: 'up', progress: 0, error: undefined });
      try {
        await uploadFile(
          it.file,
          { tag, hidden: !publish, asDoc: asDoc && canLecture(it.file.name, officeExts) },
          (progress) => update(i, { progress }),
        );
        update(i, { status: 'done', progress: 1 });
        done++;
      } catch (err) {
        update(i, { status: 'error', error: (err as Error).message });
        failed++;
      }
    }
    setRunning(false);
    if (done) toast(`${done}개 파일을 올렸어요.`);
    if (!failed) onClose();
  }

  return (
    <Modal
      title="파일 올리기"
      onClose={running ? () => {} : onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={running}>
            {todo ? '취소' : '닫기'}
          </button>
          <button className="btn primary" onClick={start} disabled={running || !todo}>
            {running ? '올리는 중…' : `${todo}개 올리기`}
          </button>
        </>
      }
    >
      <div className="form">
        <div className={`upload-drop ${over ? 'over' : ''}`}>
          {items.length > 0 && (
            <ul className="upload-list">
              {items.map((it, i) => (
                <li key={i}>
                  <FileBadge name={it.file.name} />
                  <div className="grow">
                    <div className="ellipsis">{it.file.name}</div>
                    <div className={`small ${it.status === 'error' ? 'error' : 'muted'}`}>
                      {it.status === 'error' ? it.error : formatSize(it.file.size)}
                      {it.status === 'up' && ` · ${Math.round(it.progress * 100)}%`}
                    </div>
                    {it.status === 'up' && (
                      <div className="progress">
                        <span style={{ width: `${it.progress * 100}%` }} />
                      </div>
                    )}
                  </div>
                  {it.status === 'done' ? (
                    <Check size={16} className="ok-ink" aria-label="완료" />
                  ) : (
                    !running && (
                      <button
                        className="icon-btn"
                        onClick={() => setItems((list) => list.filter((_, j) => j !== i))}
                        title="빼기"
                        aria-label={`${it.file.name} 빼기`}
                      >
                        <X size={14} />
                      </button>
                    )
                  )}
                </li>
              ))}
            </ul>
          )}
          <button type="button" className="btn small" onClick={() => picker.current?.click()} disabled={running}>
            <Plus size={14} /> 파일 추가
          </button>
          <span className="hint">끌어다 놓아도 돼요 · 파일당 최대 {maxMb}MB</span>
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files?.length) add([...e.target.files]);
              e.target.value = '';
            }}
          />
        </div>

        <TagField value={tag} onChange={setTag} tags={tags} />

        <label className="check">
          <input type="checkbox" checked={publish} onChange={(e) => setPublish(e.target.checked)} />
          학생에게 바로 공개
        </label>
        {!publish && (
          <p className="hint">숨긴 파일은 강사에게만 보여요. 나중에 ⋯ 메뉴의 ‘학생에게 공개’로 보여 줄 수 있어요.</p>
        )}
        {hasLecture && (
          <label className="check">
            <input type="checkbox" checked={asDoc} onChange={(e) => setAsDoc(e.target.checked)} />
            교안으로도 등록 (PDF·PPT·이미지·HTML을 교안 탭에서 판서하며 강의)
          </label>
        )}
        {hasLecture && asDoc && !publish && <p className="hint">교안으로 등록한 파일은 항상 학생에게 보여요.</p>}
      </div>
    </Modal>
  );
}

function EditDialog({ f, tags, onClose }: { f: FileInfo; tags: string[]; onClose: () => void }) {
  const ext = fileExt(f.name);
  const [base, setBase] = useState(ext ? f.name.slice(0, -ext.length - 1) : f.name);
  const [tag, setTag] = useState(f.tag ?? '');
  const [busy, setBusy] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.updateFile(f.id, { name: ext ? `${base.trim()}.${ext}` : base.trim(), tag: tag.trim() || null });
      onClose();
    } catch (err) {
      toast((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal
      title="이름·태그 수정"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            취소
          </button>
          <button className="btn primary" type="submit" form="file-edit" disabled={busy || !base.trim()}>
            저장
          </button>
        </>
      }
    >
      <form id="file-edit" className="form" onSubmit={save}>
        <label>
          파일 이름
          <span className="name-input">
            <input value={base} onChange={(e) => setBase(e.target.value)} maxLength={LIMITS.fileNameLen - 11} autoFocus />
            {ext && <span className="muted">.{ext}</span>}
          </span>
        </label>
        <TagField value={tag} onChange={setTag} tags={tags} />
      </form>
    </Modal>
  );
}

function StatsDialog({ f, onClose }: { f: FileInfo; onClose: () => void }) {
  const [data, setData] = useState<FileDownloads | null>(null);
  const [error, setError] = useState('');
  // Refetch when the live count changes while the dialog is open.
  const count = useStore((s) => s.files.find((x) => x.id === f.id)?.downloads);

  useEffect(() => {
    let alive = true;
    api.fileDownloads(f.id).then(
      (d) => alive && setData(d),
      (err: Error) => alive && setError(err.message),
    );
    return () => {
      alive = false;
    };
  }, [f.id, count]);

  return (
    <Modal title={`다운로드 현황 · ${f.name}`} onClose={onClose}>
      {error && <p className="error">{error}</p>}
      {!data && !error && <p className="muted">불러오는 중…</p>}
      {data && (
        <>
          <h4 className="stat-head">받은 학생 {data.downloaded.length}명</h4>
          {data.downloaded.length === 0 ? (
            <p className="muted small">아직 아무도 받지 않았어요.</p>
          ) : (
            <ul className="stat-list">
              {data.downloaded.map((d) => (
                <li key={d.name}>
                  <Check size={14} className="ok-ink" /> {d.name}
                  <span className="muted small push-right">{timeAgo(d.at)}</span>
                </li>
              ))}
            </ul>
          )}
          <h4 className="stat-head">아직 안 받은 학생 {data.pending.length}명</h4>
          {data.pending.length === 0 ? (
            <p className="muted small">{data.downloaded.length ? '모든 학생이 받았어요.' : '아직 입장한 학생이 없어요.'}</p>
          ) : (
            <div className="people">
              {data.pending.map((name) => (
                <span key={name} className="person">
                  {name}
                </span>
              ))}
            </div>
          )}
          <p className="hint stat-note">
            이 수업에 한 번이라도 입장한 학생 기준이에요. ‘모두 받기’(ZIP)도 다운로드로 세고, 미리보기는 세지 않아요.
          </p>
        </>
      )}
    </Modal>
  );
}

// ---- preview ----

function PreviewDialog({ f, ctx, onClose }: { f: FileInfo; ctx: Ctx; onClose: () => void }) {
  const kind = previewKind(f.name);
  return (
    <Modal
      size="wide"
      title={
        <>
          <FileBadge name={f.name} /> <span className="ellipsis">{f.name}</span>
        </>
      }
      onClose={onClose}
      footer={
        <>
          <span className="muted small">
            {formatSize(f.size)}
            {f.uploader && ` · ${f.uploader}`}
          </span>
          <span className="push-right" />
          <a className="btn" href={fileViewUrl(f.id)} target="_blank" rel="noopener">
            새 탭에서 열기
          </a>
          <a className="btn primary" href={fileDownloadUrl(f.id)} onClick={() => ctx.onDownload([f.id])}>
            <Download size={14} /> 다운로드
          </a>
        </>
      }
    >
      {kind === 'image' && <img className="preview-img" src={fileViewUrl(f.id)} alt={f.name} />}
      {(kind === 'text' || kind === 'notebook') && <TextPreview f={f} notebook={kind === 'notebook'} />}
    </Modal>
  );
}

const TEXT_PREVIEW_BYTES = 512 * 1024;
const NOTEBOOK_PREVIEW_BYTES = 10 * 1024 * 1024;

/** UTF-8, falling back to CP949 for files saved by Korean Windows tools. */
function decodeText(buf: ArrayBuffer, partial: boolean): string {
  try {
    // stream: true tolerates a multi-byte character cut off at the end of a partial read.
    return new TextDecoder('utf-8', { fatal: true }).decode(buf, { stream: partial });
  } catch {
    return new TextDecoder('euc-kr').decode(buf);
  }
}

function TextPreview({ f, notebook }: { f: FileInfo; notebook: boolean }) {
  const [state, setState] = useState<{ text?: string; error?: string }>({});
  const partial = !notebook && f.size > TEXT_PREVIEW_BYTES;

  useEffect(() => {
    if (notebook && f.size > NOTEBOOK_PREVIEW_BYTES) {
      setState({ error: '노트북이 너무 커서 미리볼 수 없어요. 다운로드해서 여세요.' });
      return;
    }
    const ctrl = new AbortController();
    fetch(fileViewUrl(f.id), {
      signal: ctrl.signal,
      headers: partial ? { Range: `bytes=0-${TEXT_PREVIEW_BYTES - 1}` } : undefined,
    })
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `불러오지 못했어요. (${res.status})`);
        }
        return res.arrayBuffer();
      })
      .then((buf) => setState({ text: decodeText(buf, partial) }))
      .catch((err: Error) => !ctrl.signal.aborted && setState({ error: err.message }));
    return () => ctrl.abort();
  }, [f.id, f.size, notebook, partial]);

  if (state.error) return <p className="error">{state.error}</p>;
  if (state.text === undefined) return <p className="muted">불러오는 중…</p>;
  if (notebook) return <NotebookView text={state.text} />;
  return (
    <>
      {partial && <p className="hint">앞부분 {formatSize(TEXT_PREVIEW_BYTES)}만 보여요. 전체 내용은 다운로드해서 확인하세요.</p>}
      <pre className="preview-text">{state.text}</pre>
    </>
  );
}

interface NbOutput {
  output_type: string;
  text?: string | string[];
  data?: Record<string, string | string[]>;
  ename?: string;
  evalue?: string;
}
interface NbCell {
  cell_type: string;
  source?: string | string[];
  execution_count?: number | null;
  outputs?: NbOutput[];
}

const joinSource = (s?: string | string[]) => (Array.isArray(s) ? s.join('') : (s ?? ''));

/** A read-only rendering of a Jupyter notebook: markdown, code, and text/image outputs. */
function NotebookView({ text }: { text: string }) {
  const cells = useMemo(() => {
    try {
      const nb = JSON.parse(text) as { cells?: unknown };
      return Array.isArray(nb.cells) ? (nb.cells as NbCell[]) : null;
    } catch {
      return null;
    }
  }, [text]);

  if (!cells) return <p className="error">노트북 형식을 읽을 수 없어요.</p>;
  return (
    <div className="nb">
      {cells.map((c, i) =>
        c.cell_type === 'markdown' ? (
          <div key={i} className="nb-md">
            <LiteMarkdown text={joinSource(c.source)} />
          </div>
        ) : (
          <div key={i} className="nb-cell">
            <div className="nb-prompt mono">{c.cell_type === 'code' ? `[${c.execution_count ?? ' '}]` : ''}</div>
            <div className="grow">
              <pre className="nb-code">{joinSource(c.source)}</pre>
              {c.outputs?.map((o, j) => <NbOutputView key={j} o={o} />)}
            </div>
          </div>
        ),
      )}
    </div>
  );
}

function NbOutputView({ o }: { o: NbOutput }) {
  if (o.output_type === 'stream') return <pre className="nb-out">{joinSource(o.text)}</pre>;
  if (o.output_type === 'error') return <pre className="nb-out error">{`${o.ename}: ${o.evalue}`}</pre>;
  const data = o.data ?? {};
  for (const type of ['image/png', 'image/jpeg']) {
    if (data[type]) {
      const b64 = joinSource(data[type]).replace(/\s/g, '');
      return <img className="nb-img" alt="" src={`data:${type};base64,${b64}`} />;
    }
  }
  if (data['text/plain']) return <pre className="nb-out">{joinSource(data['text/plain'])}</pre>;
  return null;
}
