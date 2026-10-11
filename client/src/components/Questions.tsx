import { useMemo, useState } from 'react';
import { Check, ThumbsUp, X } from 'lucide-react';
import type { Question } from '../../../shared/protocol.ts';
import { LIMITS } from '../../../shared/protocol.ts';
import { goTo } from '../actions.ts';
import { send } from '../socket.ts';
import { setTab, upsertQuestion, useStore } from '../store.ts';
import { timeAgo } from '../util.ts';

export function Questions() {
  const questions = useStore((s) => s.questions);
  const isTeacher = useStore((s) => s.me?.role === 'teacher');
  const [sort, setSort] = useState<'likes' | 'latest'>('latest');

  const sorted = useMemo(() => {
    const list = [...questions];
    if (sort === 'likes') list.sort((a, b) => b.likes - a.likes || b.id - a.id);
    else list.sort((a, b) => b.id - a.id);
    // Unresolved first, so open questions stay on top.
    return list.sort((a, b) => Number(a.resolved) - Number(b.resolved));
  }, [questions, sort]);

  return (
    <div className="panel">
      <div className="chip-row">
        <button className={`chip ${sort === 'likes' ? 'active' : ''}`} onClick={() => setSort('likes')}>
          좋아요순
        </button>
        <button className={`chip ${sort === 'latest' ? 'active' : ''}`} onClick={() => setSort('latest')}>
          최신순
        </button>
        <span className="muted small push-right">{questions.length}개</span>
      </div>
      <div className="panel-scroll">
        {sorted.length === 0 && <p className="empty">아직 질문이 없어요.</p>}
        {sorted.map((q) => (
          <QuestionCard key={q.id} q={q} isTeacher={isTeacher} />
        ))}
      </div>
      {!isTeacher && <QuestionComposer />}
    </div>
  );
}

function QuestionCard({ q, isTeacher }: { q: Question; isTeacher: boolean }) {
  const docName = useStore((s) => s.docs.find((d) => d.id === q.docId)?.name);
  const [answering, setAnswering] = useState(false);
  const [answer, setAnswer] = useState(q.answer ?? '');

  async function like() {
    const r = await send<{ liked: boolean; likes: number }>('question:like', { id: q.id });
    if (r.ok) upsertQuestion({ id: q.id, likes: r.data.likes, likedByMe: r.data.liked });
  }

  async function saveAnswer() {
    if ((await send('question:answer', { id: q.id, answer })).ok) setAnswering(false);
  }

  return (
    <article className={`q-card ${q.resolved ? 'resolved' : ''}`}>
      <header>
        <strong>{q.authorName ?? '익명'}</strong>
        {q.mine && <span className="tag">내 질문</span>}
        <span className="muted small">{timeAgo(q.createdAt)}</span>
        {q.page && docName && (
          <button
            className="tag link"
            title={`${docName} ${q.page}쪽으로 이동`}
            onClick={() => {
              goTo(q.docId!, q.page!);
              setTab('lecture');
            }}
          >
            p.{q.page}
          </button>
        )}
        {q.resolved && <span className="tag ok">해결됨</span>}
      </header>
      <p className="q-body">{q.body}</p>
      {q.answer && !answering && (
        <div className="q-answer">
          <span className="tag ok">강사 답변</span>
          <p>{q.answer}</p>
        </div>
      )}
      {answering && (
        <div className="q-answer-edit">
          <textarea
            value={answer}
            maxLength={LIMITS.questionLen}
            placeholder="답변을 입력하세요"
            onChange={(e) => setAnswer(e.target.value)}
            autoFocus
          />
          <div className="row">
            <button className="btn small" onClick={() => setAnswering(false)}>
              취소
            </button>
            <button className="btn small primary" onClick={saveAnswer}>
              저장
            </button>
          </div>
        </div>
      )}
      <footer>
        <button className={`like-btn ${q.likedByMe ? 'active' : ''}`} onClick={like} aria-pressed={q.likedByMe}>
          <ThumbsUp size={13} /> {q.likes}
        </button>
        {isTeacher && (
          <>
            <button className="text-btn small" onClick={() => setAnswering((v) => !v)}>
              {q.answer ? '답변 수정' : '답변'}
            </button>
            <button
              className="text-btn small"
              onClick={() => send('question:resolve', { id: q.id, resolved: !q.resolved })}
            >
              <Check size={13} /> {q.resolved ? '미해결로' : '해결'}
            </button>
          </>
        )}
        {(isTeacher || q.mine) && (
          <button
            className="text-btn small danger push-right"
            onClick={() => confirm('이 질문을 삭제할까요?') && send('question:delete', { id: q.id })}
            aria-label="질문 삭제"
          >
            <X size={13} /> 삭제
          </button>
        )}
      </footer>
    </article>
  );
}

function QuestionComposer() {
  const [body, setBody] = useState('');
  const [anonymous, setAnonymous] = useState(false);
  const [busy, setBusy] = useState(false);
  const view = useStore((s) => s.view);

  async function submit() {
    const text = body.trim();
    if (!text || busy) return;
    setBusy(true);
    const r = await send<Question>('question:create', {
      body: text,
      anonymous,
      docId: view.docId,
      page: view.docId ? view.page : null,
    });
    setBusy(false);
    if (!r.ok) return;
    const q = r.data;
    setBody('');
    useStore.setState((s) => ({
      questions: s.questions.some((x) => x.id === q.id) ? s.questions : [...s.questions, q],
    }));
  }

  return (
    <div className="composer">
      <div className="composer-row">
        <textarea
          value={body}
          maxLength={LIMITS.questionLen}
          placeholder="질문을 입력하세요... (Shift+Enter로 줄바꿈)"
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <button className="btn primary" disabled={!body.trim() || busy} onClick={submit}>
          등록
        </button>
      </div>
      <label className="check">
        <input type="checkbox" checked={anonymous} onChange={(e) => setAnonymous(e.target.checked)} /> 익명으로 질문
        {view.docId && <span className="muted small push-right">p.{view.page}에 연결됨</span>}
      </label>
    </div>
  );
}
