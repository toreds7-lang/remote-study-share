import type { DocInfo, FileDownloads, Me, RoomInfo } from '../../shared/protocol.ts';

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body instanceof FormData || body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `요청 실패 (${res.status})`);
  return data as T;
}

export const api = {
  config: () => call<{ adminRequired: boolean }>('GET', '/api/config'),
  room: (code: string) => call<RoomInfo>('GET', `/api/rooms/${encodeURIComponent(code)}`),
  createRoom: (body: {
    title: string;
    code?: string;
    teacherName: string;
    teacherPin: string;
    adminPassword?: string;
  }) => call<{ code: string }>('POST', '/api/rooms', body),
  join: (body: { code: string; name: string; role: 'teacher' | 'student'; pin?: string }) =>
    call<{ code: string }>('POST', '/api/join', body),
  session: () =>
    call<{ user: Me & { roomCode: string }; room: RoomInfo } | { user: null; room: null }>('GET', '/api/session'),
  logout: () => call('POST', '/api/logout'),
  deleteDoc: (id: string) => call('DELETE', `/api/docs/${encodeURIComponent(id)}`),
  blankDoc: (body: { name: string; pages: number; paper: Paper }) => call<DocInfo>('POST', '/api/docs/blank', body),
  siteUrl: (id: string) => call<{ url: string }>('GET', `/api/docs/${encodeURIComponent(id)}/site`),
  deletePage: (id: string, page: number) =>
    call<DocInfo>('DELETE', `/api/docs/${encodeURIComponent(id)}/pages/${page}`),
  updateFile: (id: string, body: { name?: string; tag?: string | null; hidden?: boolean }) =>
    call('PATCH', `/api/files/${encodeURIComponent(id)}`, body),
  deleteFile: (id: string) => call('DELETE', `/api/files/${encodeURIComponent(id)}`),
  makeLecture: (id: string) => call('POST', `/api/files/${encodeURIComponent(id)}/lecture`),
  fileDownloads: (id: string) => call<FileDownloads>('GET', `/api/files/${encodeURIComponent(id)}/downloads`),
};

export const fileDownloadUrl = (id: string) => `/api/files/${encodeURIComponent(id)}/download`;
export const fileViewUrl = (id: string) => `/api/files/${encodeURIComponent(id)}/view`;
export const zipUrl = (ids: string[]) => `/api/files/zip?ids=${ids.map(encodeURIComponent).join(',')}`;

/** POSTs a form with upload progress reporting (fetch has no upload progress). */
function uploadForm<T>(url: string, form: FormData, onProgress: (ratio: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let data: { error?: string } = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        // Non-JSON error page.
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as T);
      else reject(new Error(data.error ?? `업로드 실패 (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('업로드 중 네트워크 오류가 발생했어요.'));
    xhr.send(form);
  });
}

/** Background of a whiteboard page: plain, squared or lined. */
export type Paper = 'blank' | 'grid' | 'lines';

/** Uploads one file as a new 교안, or several images as one 교안 with a page each. */
export function uploadLecture(files: File[], onProgress: (ratio: number) => void): Promise<DocInfo> {
  const form = new FormData();
  for (const file of files) form.append('file', file);
  return uploadForm('/api/docs', form, onProgress);
}

/** Inserts a page into a PDF 교안 so that it becomes page `at`: an image, or blank paper. */
export function insertPage(docId: string, at: number, content: { image: File } | { paper: Paper }): Promise<DocInfo> {
  const form = new FormData();
  form.append('at', String(at));
  if ('image' in content) form.append('image', content.image);
  else form.append('paper', content.paper);
  return uploadForm(`/api/docs/${encodeURIComponent(docId)}/pages`, form, () => {});
}

export function uploadFile(
  file: File,
  opts: { tag: string; hidden: boolean; asDoc: boolean },
  onProgress: (ratio: number) => void,
): Promise<{ id: string }> {
  const form = new FormData();
  form.append('tag', opts.tag);
  form.append('hidden', opts.hidden ? '1' : '0');
  form.append('asDoc', opts.asDoc ? '1' : '0');
  form.append('file', file);
  return uploadForm('/api/files', form, onProgress);
}
