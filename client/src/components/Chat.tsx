import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Send } from 'lucide-react';
import { LIMITS } from '../../../shared/protocol.ts';
import { send } from '../socket.ts';
import { useStore } from '../store.ts';
import { clockTime } from '../util.ts';

export function Chat() {
  const chat = useStore((s) => s.chat);
  const meId = useStore((s) => s.me?.id);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);

  // Keep scrolled to the newest message unless the user scrolled up to read.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [chat]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  async function submit() {
    const text = body.trim();
    if (!text || busy) return;
    setBusy(true);
    const { ok } = await send('chat:send', { body: text });
    setBusy(false);
    if (ok) {
      setBody('');
      stick.current = true;
    }
  }

  return (
    <div className="panel">
      <div
        className="panel-scroll chat-list"
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {chat.length === 0 && <p className="empty">아직 메시지가 없어요.</p>}
        {chat.map((m) => (
          <div key={m.id} className={`chat-msg ${m.userId === meId ? 'mine' : ''} ${m.role}`}>
            <div className="chat-meta">
              <strong>{m.name}</strong>
              {m.role === 'teacher' && <span className="tag ok">강사</span>}
              <span className="muted small">{clockTime(m.createdAt)}</span>
            </div>
            <p>{m.body}</p>
          </div>
        ))}
      </div>
      <div className="composer">
        <div className="composer-row">
          <textarea
            value={body}
            maxLength={LIMITS.chatLen}
            placeholder="메시지를 입력하세요... (Enter로 전송)"
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void submit();
              }
            }}
          />
          <button className="btn primary" disabled={!body.trim() || busy} onClick={submit} aria-label="전송">
            <Send size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}
