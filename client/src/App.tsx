import { useCallback, useEffect, useState } from 'react';
import { useHistory } from './actions.ts';
import { api } from './api.ts';
import { Lobby } from './components/Lobby.tsx';
import { Room } from './components/Room.tsx';
import { connect, socket } from './socket.ts';
import { toast, useStore } from './store.ts';

const codeFromPath = () => /^\/room\/([A-Za-z0-9]{4,12})/.exec(location.pathname)?.[1] ?? '';

export function App() {
  const [phase, setPhase] = useState<'loading' | 'lobby' | 'room'>('loading');
  const dark = useStore((s) => s.dark);

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [dark]);

  const enter = useCallback((code: string) => {
    if (location.pathname !== `/room/${code}`) history.pushState(null, '', `/room/${code}`);
    setPhase('room');
    connect(() => {
      setPhase('lobby');
      toast('세션이 만료되었어요. 다시 입장해 주세요.');
    });
  }, []);

  useEffect(() => {
    api
      .session()
      .then((s) => {
        const urlCode = codeFromPath();
        if (!s.room || (urlCode && urlCode !== s.room.code)) setPhase('lobby');
        else enter(s.room.code);
      })
      .catch(() => setPhase('lobby'));
  }, [enter]);

  async function leave() {
    if (!confirm('수업에서 나갈까요?')) return;
    socket.disconnect();
    await api.logout().catch(() => {});
    useStore.setState({ me: null, room: null, tab: 'lecture', drawMode: false, ai: [], hands: [], myHand: false });
    useHistory.setState({ stacks: {} });
    setPhase('lobby');
  }

  if (phase === 'loading') return <div className="center muted">불러오는 중…</div>;
  if (phase === 'lobby') return <Lobby initialCode={codeFromPath()} onJoined={enter} />;
  return <Room onLeave={leave} />;
}
