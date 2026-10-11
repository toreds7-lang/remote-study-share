// Teacher actions that add 교안 or change their pages.
import { BROWSER_IMAGE_EXTS, canLecture, fileExt, lectureSource, LECTURE_IMAGE_EXTS } from '../../shared/files.ts';
import type { DocInfo } from '../../shared/protocol.ts';
import { goTo } from './actions.ts';
import { api, insertPage, uploadLecture, type Paper } from './api.ts';
import { toast, upsertDoc, useStore } from './store.ts';

const setStatus = (uploadStatus: string | null) => useStore.setState({ uploadStatus });

const isImage = (name: string) => LECTURE_IMAGE_EXTS.has(fileExt(name)) || BROWSER_IMAGE_EXTS.has(fileExt(name));
const byName = (a: File, b: File) => a.name.localeCompare(b.name, 'ko', { numeric: true });

/** PNG and JPG go up as they are; other images (GIF, WebP, BMP, AVIF) are re-encoded as PNG here. */
async function lectureImage(file: File): Promise<File> {
  const ext = fileExt(file.name);
  if (LECTURE_IMAGE_EXTS.has(ext)) return file;
  // Clipboard images may have no usable name.
  const base = (ext ? file.name.slice(0, -ext.length - 1) : file.name) || 'image';
  if (file.type === 'image/png' || file.type === 'image/jpeg') {
    return new File([file], `${base}.${file.type === 'image/png' ? 'png' : 'jpg'}`, { type: file.type });
  }
  try {
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
    bitmap.close();
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
    if (!blob) throw new Error();
    return new File([blob], `${base}.png`, { type: 'image/png' });
  } catch {
    throw new Error(`${file.name}: 이 브라우저에서 읽을 수 없는 이미지예요. PNG나 JPG로 바꿔 올려 주세요.`);
  }
}

/**
 * Uploads files as new 교안 and shows the last one. Images go together into one 교안
 * (a page each, in name order); every other file becomes its own 교안.
 */
export async function addLectureFiles(files: File[]) {
  const { officeExts } = useStore.getState();
  const images: File[] = [];
  const batches: File[][] = [];
  const rejected: string[] = [];
  for (const f of files) {
    if (isImage(f.name) || (f.type.startsWith('image/') && !fileExt(f.name))) images.push(f);
    else if (canLecture(f.name, officeExts)) batches.push([f]);
    else rejected.push(f.name);
  }
  if (rejected.length) {
    const office = rejected.some((n) => lectureSource(n) === 'office');
    toast(
      office
        ? `이 서버에는 변환 프로그램이 없어 PDF로 저장해 올려 주세요: ${rejected.join(', ')}`
        : `교안으로 쓸 수 없는 파일이에요: ${rejected.join(', ')} (PDF·PPT·워드·엑셀·이미지·HTML·ZIP)`,
      6000,
    );
  }
  if (images.length) {
    try {
      batches.push(await Promise.all(images.sort(byName).map(lectureImage)));
    } catch (err) {
      toast((err as Error).message, 6000);
    }
  }

  let last: DocInfo | null = null;
  for (const batch of batches) {
    const converting = lectureSource(batch[0].name) === 'office';
    try {
      const doc = await uploadLecture(batch, (ratio) =>
        setStatus(ratio < 1 ? `올리는 중 ${Math.round(ratio * 100)}%` : converting ? 'PDF로 변환 중…' : '처리 중…'),
      );
      upsertDoc(doc);
      last = doc;
      toast(`‘${doc.name}’ 교안을 올렸어요.${doc.kind === 'pdf' ? ` (${doc.pages}쪽)` : ''}`);
    } catch (err) {
      toast(`${batch.length > 1 ? `이미지 ${batch.length}장` : batch[0].name}: ${(err as Error).message}`, 6000);
    }
  }
  setStatus(null);
  if (last) goTo(last.id, 1);
}

/** Inserts a page after the current one and shows it. */
async function insertAfterCurrent(content: { image: File } | { paper: Paper }): Promise<number | null> {
  const { view, docs } = useStore.getState();
  const doc = docs.find((d) => d.id === view.docId);
  if (doc?.kind !== 'pdf') return null;
  const at = view.page + 1;
  const updated = await insertPage(doc.id, at, content);
  // Update the page count first, or goTo would stop at the old last page.
  upsertDoc(updated);
  goTo(doc.id, at);
  return at;
}

export async function addBlankPage(paper: Paper) {
  try {
    const at = await insertAfterCurrent({ paper });
    if (at) toast(`${at}쪽에 빈 페이지를 넣었어요.`);
  } catch (err) {
    toast((err as Error).message);
  }
}

/** Images become pages after the current page (or, on an HTML 교안 or none, a new 교안). */
export async function addImagePages(files: File[]) {
  const { view, docs } = useStore.getState();
  if (docs.find((d) => d.id === view.docId)?.kind !== 'pdf') {
    const time = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
    const named = files.map((f, i) =>
      fileExt(f.name) && f.name !== 'image.png' ? f : new File([f], `붙여넣은 이미지 ${time}${i ? ` (${i + 1})` : ''}.png`, { type: f.type }),
    );
    return addLectureFiles(named);
  }
  setStatus('이미지 넣는 중…');
  let first: number | null = null;
  try {
    for (const f of files.sort(byName)) {
      const at = await insertAfterCurrent({ image: await lectureImage(f) });
      first ??= at;
    }
    if (first) toast(files.length > 1 ? `${first}쪽부터 이미지 ${files.length}장을 넣었어요.` : `${first}쪽에 이미지를 넣었어요.`);
  } catch (err) {
    toast((err as Error).message, 5000);
  } finally {
    setStatus(null);
  }
}

export async function deleteCurrentPage() {
  const { view, docs } = useStore.getState();
  const doc = docs.find((d) => d.id === view.docId);
  if (doc?.kind !== 'pdf') return;
  if (doc.pages <= 1) return toast('마지막 남은 페이지는 지울 수 없어요.');
  if (!confirm(`${view.page}쪽을 삭제할까요?\n이 페이지의 판서와 학생 필기도 함께 지워져요. 파일 탭의 원본 파일은 그대로예요.`)) return;
  try {
    upsertDoc(await api.deletePage(doc.id, view.page));
    toast(`${view.page}쪽을 삭제했어요.`);
  } catch (err) {
    toast((err as Error).message);
  }
}

export async function createWhiteboard(name: string, pages: number, paper: Paper) {
  const doc = await api.blankDoc({ name, pages, paper });
  upsertDoc(doc);
  goTo(doc.id, 1);
}

/** `accept` for the 교안 file picker. */
export function lectureAccept(officeExts: string[]) {
  const exts = ['pdf', 'html', 'htm', 'zip', ...LECTURE_IMAGE_EXTS, ...BROWSER_IMAGE_EXTS, ...officeExts];
  return [...exts.map((e) => `.${e}`), 'image/*'].join(',');
}
