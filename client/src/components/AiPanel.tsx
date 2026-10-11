import { useLayoutEffect, useRef, useState } from 'react';
import { Send, Sparkles } from 'lucide-react';
import { LIMITS } from '../../../shared/protocol.ts';
import { frameText } from '../frame.ts';
import { pageText } from '../pdf.ts';
import { useStore, type AiMessage } from '../store.ts';
import { LiteMarkdown } from './LiteMarkdown.tsx';

const SUGGESTIONS = ['이 페이지 핵심 요약해줘', '어려운 용어를 쉽게 설명해줘', '이 내용으로 확인 문제 2개 내줘'];

function updateLast(patch: (m: AiMessage) => AiMessage) {
  useStore.setState((s) => {
    if (!s.ai.length) return {};
    const ai = [...s.ai];
    ai[ai.length - 1] = patch(ai[ai.length - 1]);
    return { ai };
  });
}

export function AiPanel() {
  const messages = useStore((s) => s.ai);
  const view = useStore((s) => s.view);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  async function ask(question: string) {
    question = question.trim();
    if (!question || busy) return;
    setBusy(true);
    setInput('');
    const { view: v, ai } = useStore.getState();
    const history = ai
      .filter((m) => !m.error && m.text)
      .slice(-6)
      .map((m) => ({ role: m.role, text: m.text.slice(0, 4000) }));
    useStore.setState({
      ai: [...ai, { role: 'user', text: question, page: v.docId ? v.page : null }, { role: 'assistant', text: '' }],
    });

    try {
      const kind = useStore.getState().docs.find((d) => d.id === v.docId)?.kind;
      const context = !v.docId
        ? ''
        : kind === 'html'
          ? await frameText(v.docId)
          : await pageText(v.docId, v.page).catch(() => '');
      const res = await fetch('/api/ai/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: question.slice(0, LIMITS.aiQuestionLen),
          docId: v.docId,
          page: v.docId ? v.page : null,
          pageText: context.slice(0, LIMITS.aiContextLen),
          history,
        }),
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error ?? 'AI 응답을 받지 못했어요.');
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        updateLast((m) => ({ ...m, text: m.text + chunk }));
      }
      updateLast((m) => (m.text ? m : { ...m, text: '(빈 응답)', error: true }));
    } catch (err) {
      updateLast((m) => ({ ...m, text: (err as Error).message, error: true }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <div className="panel-scroll" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="ai-intro">
            <Sparkles size={22} />
            <p>
              지금 보고 있는 교안 페이지{view.docId ? ` (p.${view.page})` : ''}를 바탕으로 AI가 답해요.
              <br />
              <span className="muted small">수업 내용 확인용이에요. 중요한 내용은 강사에게 질문하세요.</span>
            </p>
            <div className="chip-col">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="chip" disabled={!view.docId} onClick={() => ask(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`ai-msg ${m.role} ${m.error ? 'error' : ''}`}>
            {m.role === 'user' && m.page && <span className="tag">p.{m.page}</span>}
            <div className="bubble">
              {m.role === 'assistant' && m.text && !m.error ? (
                <LiteMarkdown text={m.text} />
              ) : (
                m.text || (busy && i === messages.length - 1 ? '생각 중…' : '')
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="composer">
        <div className="composer-row">
          <textarea
            value={input}
            maxLength={LIMITS.aiQuestionLen}
            placeholder="이 페이지에 대해 AI에게 물어보세요"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void ask(input);
              }
            }}
          />
          <button className="btn primary" disabled={!input.trim() || busy} onClick={() => ask(input)} aria-label="AI에게 질문">
            <Send size={15} />
          </button>
        </div>
        {messages.length > 0 && (
          <button className="text-btn small" onClick={() => useStore.setState({ ai: [] })} disabled={busy}>
            대화 지우기
          </button>
        )}
      </div>
    </div>
  );
}
