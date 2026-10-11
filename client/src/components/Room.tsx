import { useEffect, useState } from 'react';
import { ArrowLeft, ChevronRight, Columns2, Hand, Moon, Sun } from 'lucide-react';
import { pruneLive, setSideTab, setTab, useStore, writePref, type MainTab } from '../store.ts';
import { send } from '../socket.ts';
import { AiPanel } from './AiPanel.tsx';
import { Chat } from './Chat.tsx';
import { FilesPane } from './FilesPane.tsx';
import { HomePane, PracticePane } from './Panes.tsx';
import { LecturePane } from './LecturePane.tsx';
import { Questions } from './Questions.tsx';

const TABS: { id: MainTab; label: string }[] = [
  { id: 'home', label: '홈' },
  { id: 'lecture', label: '교안' },
  { id: 'practice', label: '실습' },
  { id: 'questions', label: '질문' },
  { id: 'chat', label: '채팅' },
  { id: 'files', label: '파일' },
];

export function Room({ onLeave }: { onLeave: () => void }) {
  const tab = useStore((s) => s.tab);
  const sideOpen = useStore((s) => s.sideOpen);

  useEffect(() => {
    const t = setInterval(pruneLive, 5000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="app">
      <Header onLeave={onLeave} />
      <TabBar />
      <main className={`main ${tab === 'lecture' && sideOpen ? 'with-side' : ''}`}>
        <section className="content">
          {tab === 'home' && <HomePane />}
          {tab === 'lecture' && <LecturePane />}
          {tab === 'practice' && <PracticePane />}
          {tab === 'questions' && (
            <div className="wide-panel">
              <Questions />
            </div>
          )}
          {tab === 'chat' && (
            <div className="wide-panel">
              <Chat />
            </div>
          )}
          {tab === 'files' && <FilesPane />}
        </section>
        {tab === 'lecture' && sideOpen && <SidePanel />}
      </main>
      <HandButton />
      <Toasts />
    </div>
  );
}

function Header({ onLeave }: { onLeave: () => void }) {
  const room = useStore((s) => s.room);
  const me = useStore((s) => s.me);
  const dark = useStore((s) => s.dark);
  const connected = useStore((s) => s.connected);
  const teacherOnline = useStore((s) => s.online.some((u) => u.role === 'teacher'));

  return (
    <header className="topbar">
      <button className="icon-btn bordered" onClick={onLeave} title="나가기" aria-label="나가기">
        <ArrowLeft size={16} />
      </button>
      <span className="logo">
        <span className="logo-mark">≋</span> StudyShare
      </span>
      <span className="course-title" title={room?.title}>
        {room?.title}
      </span>
      <span className="badge code" title="수업 코드">
        {room?.code}
      </span>
      {!connected ? (
        <span className="badge offline">연결 중…</span>
      ) : teacherOnline ? (
        <span className="badge live">● LIVE</span>
      ) : (
        <span className="badge offline">강사 대기 중</span>
      )}
      <span className="push-right" />
      <span className="mode-label">
        {me?.name} · {me?.role === 'teacher' ? '강사 모드' : '학생 모드'}
      </span>
      <button
        className="icon-btn bordered"
        title={dark ? '라이트 모드' : '다크 모드'}
        aria-label="테마 전환"
        onClick={() => {
          useStore.setState({ dark: !dark });
          writePref('ss.dark', !dark);
        }}
      >
        {dark ? <Sun size={16} /> : <Moon size={16} />}
      </button>
      <button className="btn" onClick={onLeave}>
        로그아웃
      </button>
    </header>
  );
}

function TabBar() {
  const tab = useStore((s) => s.tab);
  const sideOpen = useStore((s) => s.sideOpen);
  const unread = useStore((s) => s.unread);
  return (
    <nav className="tabbar">
      {TABS.map((t) => {
        const count =
          t.id === 'questions' ? unread.questions : t.id === 'chat' ? unread.chat : t.id === 'files' ? unread.files : 0;
        return (
          <button key={t.id} className={`tab ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
            {t.label}
            {count > 0 && tab !== t.id && <span className="count">{count}</span>}
          </button>
        );
      })}
      <span className="push-right" />
      {tab === 'lecture' && (
        <button
          className={`btn ${sideOpen ? 'active' : ''}`}
          onClick={() => {
            useStore.setState({ sideOpen: !sideOpen });
            writePref('ss.sideOpen', !sideOpen);
          }}
          title="교안 옆에 질문/채팅 패널 보기"
        >
          <Columns2 size={15} /> 분할 보기
        </button>
      )}
    </nav>
  );
}

function SidePanel() {
  const sideTab = useStore((s) => s.sideTab);
  const unread = useStore((s) => s.unread);
  const aiEnabled = useStore((s) => s.aiEnabled);
  const tabs = [
    { id: 'questions' as const, label: '질문', count: unread.questions },
    { id: 'chat' as const, label: '채팅', count: unread.chat },
    ...(aiEnabled ? [{ id: 'ai' as const, label: 'AI 도우미', count: 0 }] : []),
  ];
  const current = sideTab === 'ai' && !aiEnabled ? 'questions' : sideTab;

  return (
    <aside className="side">
      <div className="side-tabs">
        {tabs.map((t) => (
          <button key={t.id} className={`side-tab ${current === t.id ? 'active' : ''}`} onClick={() => setSideTab(t.id)}>
            {t.label}
            {t.count > 0 && current !== t.id && <span className="count">{t.count}</span>}
          </button>
        ))}
        <button
          className="icon-btn bordered push-right"
          title="패널 닫기"
          aria-label="패널 닫기"
          onClick={() => {
            useStore.setState({ sideOpen: false });
            writePref('ss.sideOpen', false);
          }}
        >
          <ChevronRight size={15} />
        </button>
      </div>
      {current === 'questions' && <Questions />}
      {current === 'chat' && <Chat />}
      {current === 'ai' && <AiPanel />}
    </aside>
  );
}

function HandButton() {
  const isTeacher = useStore((s) => s.me?.role === 'teacher');
  const myHand = useStore((s) => s.myHand);
  const hands = useStore((s) => s.hands);
  const [open, setOpen] = useState(false);

  if (!isTeacher) {
    return (
      <button
        className={`hand-btn ${myHand ? 'raised' : ''}`}
        title={myHand ? '손 내리기' : '손 들기'}
        aria-pressed={myHand}
        onClick={async () => {
          const next = !myHand;
          useStore.setState({ myHand: next });
          if (!(await send('hand', { raised: next })).ok) useStore.setState({ myHand: !next });
        }}
      >
        <Hand size={22} />
      </button>
    );
  }

  return (
    <>
      <button
        className={`hand-btn ${hands.length ? 'raised' : ''}`}
        title="손 든 학생"
        onClick={() => setOpen((v) => !v)}
      >
        <Hand size={22} />
        {hands.length > 0 && <span className="count">{hands.length}</span>}
      </button>
      {open && (
        <div className="hand-popover">
          <div className="row">
            <strong>손 든 학생 {hands.length}명</strong>
            {hands.length > 0 && (
              <button className="text-btn small push-right" onClick={() => send('hand:lower', { userId: null })}>
                모두 내리기
              </button>
            )}
          </div>
          {hands.length === 0 && <p className="muted small">아직 손 든 학생이 없어요.</p>}
          {hands.map((h) => (
            <div key={h.userId} className="row">
              <span>✋ {h.name}</span>
              <button className="text-btn small push-right" onClick={() => send('hand:lower', { userId: h.userId })}>
                내리기
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="toast">
          {t.text}
        </div>
      ))}
    </div>
  );
}
