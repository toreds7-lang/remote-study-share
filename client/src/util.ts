export function timeAgo(ts: number): string {
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (sec < 60) return '방금';
  if (sec < 3600) return `${Math.floor(sec / 60)}분 전`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}시간 전`;
  return new Date(ts).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
}

/** 5.5KB, 2.4MB… (one decimal, like the LMS). */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  const units = ['KB', 'MB', 'GB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)}${units[i]}`;
}

/** Date section of the file list: 오늘, 어제, 이번 주 (from Monday), 이번 달, 이전. */
export function dateGroup(ts: number, now = new Date()): string {
  const day = (offset: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset).getTime();
  if (ts >= day(0)) return '오늘';
  if (ts >= day(1)) return '어제';
  if (ts >= day((now.getDay() + 6) % 7)) return '이번 주';
  if (ts >= new Date(now.getFullYear(), now.getMonth(), 1).getTime()) return '이번 달';
  return '이전';
}

export function clockTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
}
