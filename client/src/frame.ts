// The live HTML 교안 frame on screen, so toolbar buttons and the AI helper can talk to it.
// The page runs in a sandbox with an opaque origin, hence postMessage with '*'.

let current: { docId: string; win: Window } | null = null;

export function setFrame(docId: string, win: Window | null) {
  if (win) current = { docId, win };
  else if (current?.docId === docId) current = null;
}

/** Sends a command to the bridge script in the frame (see server/site-bridge.js). */
export function frameCommand(msg: { type: string; [key: string]: unknown }) {
  current?.win.postMessage(msg, '*');
}

let seq = 0;
const waiting = new Map<number, (text: string) => void>();

/** Visible text of the page, used as context for the AI helper ('' if the frame doesn't answer). */
export function frameText(docId: string): Promise<string> {
  if (current?.docId !== docId) return Promise.resolve('');
  const id = ++seq;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    current!.win.postMessage({ type: 'ss:text', id }, '*');
    setTimeout(() => waiting.delete(id) && resolve(''), 1500);
  });
}

export function onFrameText(id: number, text: string) {
  waiting.get(id)?.(text);
  waiting.delete(id);
}
