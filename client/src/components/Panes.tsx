import { Copy, Users } from 'lucide-react';
import { setTab, toast, useStore } from '../store.ts';

export function HomePane() {
  const room = useStore((s) => s.room);
  const isTeacher = useStore((s) => s.me?.role === 'teacher');
  const online = useStore((s) => s.online);
  const docs = useStore((s) => s.docs);
  const teacher = useStore((s) => s.teacher);
  const current = docs.find((d) => d.id === teacher.docId);
  const joinUrl = `${location.origin}/room/${room?.code}`;

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(joinUrl);
      toast('입장 링크를 복사했어요.');
    } catch {
      prompt('입장 링크를 복사하세요', joinUrl);
    }
  }

  return (
    <div className="page-pad">
      <div className="card hero">
        <h1>{room?.title}</h1>
        <p className="muted">
          수업 코드 <strong className="mono">{room?.code}</strong>
        </p>
        <div className="row wrap">
          <button className="btn primary" onClick={() => setTab('lecture')}>
            교안 보기
          </button>
          {isTeacher && (
            <button className="btn" onClick={copyLink}>
              <Copy size={14} /> 학생 입장 링크 복사
            </button>
          )}
        </div>
        {current && (
          <p className="muted small">
            현재 강의: {current.name} · {current.kind === 'html' ? `p.${teacher.page}` : `${teacher.page}/${current.pages}쪽`}
          </p>
        )}
      </div>

      <div className="card">
        <h2>
          <Users size={16} /> 접속 중 {online.length}명
        </h2>
        <div className="people">
          {online.map((u) => (
            <span key={u.id} className={`person ${u.role}`}>
              {u.name}
              {u.role === 'teacher' && ' (강사)'}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

export function PracticePane() {
  return (
    <div className="page-pad">
      <div className="card">
        <h2>실습</h2>
        <p className="muted">실습 기능은 준비 중이에요.</p>
      </div>
    </div>
  );
}
