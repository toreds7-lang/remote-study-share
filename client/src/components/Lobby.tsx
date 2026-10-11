import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { LIMITS } from '../../../shared/protocol.ts';

export function Lobby({ initialCode, onJoined }: { initialCode: string; onJoined: (code: string) => void }) {
  const [mode, setMode] = useState<'join' | 'create'>('join');
  return (
    <div className="lobby">
      <div className="lobby-card">
        <div className="lobby-brand">
          <span className="logo-mark">≋</span> StudyShare
        </div>
        <p className="muted">실시간 교안 공유 · 판서 · 질문</p>
        <div className="seg">
          <button className={mode === 'join' ? 'active' : ''} onClick={() => setMode('join')}>
            수업 참여
          </button>
          <button className={mode === 'create' ? 'active' : ''} onClick={() => setMode('create')}>
            새 수업 만들기
          </button>
        </div>
        {mode === 'join' ? <JoinForm initialCode={initialCode} onJoined={onJoined} /> : <CreateForm onJoined={onJoined} />}
      </div>
    </div>
  );
}

function JoinForm({ initialCode, onJoined }: { initialCode: string; onJoined: (code: string) => void }) {
  const [code, setCode] = useState(initialCode);
  const [name, setName] = useState(() => localStorage.getItem('ss.name') ?? '');
  const [role, setRole] = useState<'student' | 'teacher'>('student');
  const [pin, setPin] = useState('');
  const [title, setTitle] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setTitle(null);
    if (!/^[A-Za-z0-9]{4,12}$/.test(code.trim())) return;
    const t = setTimeout(() => {
      api
        .room(code.trim())
        .then((r) => setTitle(r.title))
        .catch(() => setTitle(''));
    }, 250);
    return () => clearTimeout(t);
  }, [code]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await api.join({ code: code.trim(), name: name.trim(), role, pin: pin || undefined });
      try {
        localStorage.setItem('ss.name', name.trim());
      } catch {
        // ignore
      }
      onJoined(res.code);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="form">
      <label>
        수업 코드
        <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="예: 261007" required autoFocus={!initialCode} />
        {title && <span className="hint ok">✓ {title}</span>}
        {title === '' && <span className="hint err">존재하지 않는 수업 코드예요.</span>}
      </label>
      <label>
        이름
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={LIMITS.nameLen} required autoFocus={!!initialCode} />
      </label>
      <div className="seg small">
        <button type="button" className={role === 'student' ? 'active' : ''} onClick={() => setRole('student')}>
          학생
        </button>
        <button type="button" className={role === 'teacher' ? 'active' : ''} onClick={() => setRole('teacher')}>
          강사
        </button>
      </div>
      <label>
        {role === 'teacher' ? '강사 PIN' : '비밀번호 (선택)'}
        <input type="password" value={pin} onChange={(e) => setPin(e.target.value)} required={role === 'teacher'} autoComplete="current-password" />
        {role === 'student' && (
          <span className="hint">처음 입장할 때 정하면, 다른 기기에서도 같은 이름으로 내 필기를 불러올 수 있어요.</span>
        )}
      </label>
      {error && <p className="error">{error}</p>}
      <button className="btn primary block" disabled={busy}>
        {busy ? '입장 중…' : '입장하기'}
      </button>
    </form>
  );
}

function CreateForm({ onJoined }: { onJoined: (code: string) => void }) {
  const [title, setTitle] = useState('');
  const [teacherName, setTeacherName] = useState('');
  const [teacherPin, setTeacherPin] = useState('');
  const [code, setCode] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [adminRequired, setAdminRequired] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.config().then((c) => setAdminRequired(c.adminRequired), () => {});
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await api.createRoom({
        title: title.trim(),
        teacherName: teacherName.trim(),
        teacherPin,
        code: code.trim() || undefined,
        adminPassword: adminPassword || undefined,
      });
      onJoined(res.code);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="form">
      <label>
        수업 이름
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={LIMITS.titleLen} required placeholder="예: AI Agent 서비스 운영을 위한 LLMOps" />
      </label>
      <label>
        강사 이름
        <input value={teacherName} onChange={(e) => setTeacherName(e.target.value)} maxLength={LIMITS.nameLen} required />
      </label>
      <label>
        강사 PIN (4자 이상)
        <input type="password" value={teacherPin} onChange={(e) => setTeacherPin(e.target.value)} minLength={4} required autoComplete="new-password" />
        <span className="hint">강사로 입장할 때 필요해요. 학생에게 알려주지 마세요.</span>
      </label>
      <label>
        수업 코드 (선택)
        <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="비워두면 6자리 숫자로 자동 생성" pattern="[A-Za-z0-9]{4,12}" />
      </label>
      {adminRequired && (
        <label>
          관리자 비밀번호
          <input type="password" value={adminPassword} onChange={(e) => setAdminPassword(e.target.value)} required />
        </label>
      )}
      {error && <p className="error">{error}</p>}
      <button className="btn primary block" disabled={busy}>
        {busy ? '만드는 중…' : '수업 만들고 입장'}
      </button>
    </form>
  );
}
