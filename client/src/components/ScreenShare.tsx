import { useEffect, useRef, useState } from 'react';
import { Clapperboard, Copy, FileText, MonitorUp, Network, Type } from 'lucide-react';
import type { RelayInfo, ScreenNode } from '../../../shared/protocol.ts';
import { setShareMotion, startSharing, stopSharing } from '../screen.ts';
import { send } from '../socket.ts';
import { publicOrigin, toast, useStore } from '../store.ts';
import { Menu } from './Menu.tsx';
import { Modal } from './Modal.tsx';

/** Student: the teacher's shared screen, in place of the 교안. */
export function ScreenViewer() {
  const track = useStore((s) => s.screenTrack);
  const status = useStore((s) => s.screenStatus);
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    video.srcObject = track ? new MediaStream([track]) : null;
    if (track) video.play().catch(() => {});
  }, [track]);

  return (
    <div className="viewer screen-view">
      <video
        ref={ref}
        className="screen-video"
        autoPlay
        muted
        playsInline
        onDoubleClick={(e) => {
          if (document.fullscreenElement) void document.exitFullscreen();
          else void e.currentTarget.closest<HTMLElement>('.lecture')?.requestFullscreen?.();
        }}
      />
      {status && <div className="screen-status">{status}</div>}
    </div>
  );
}

/** Student toolbar while the shared screen is shown. */
export function ScreenToolbarInfo() {
  const via = useStore((s) => s.screenVia);
  return (
    <>
      <button className="pill-btn" onClick={() => useStore.setState({ screenView: false })} title="강사 화면 대신 교안을 봐요">
        <FileText size={14} /> 교안 보기
      </button>
      <span className="muted small" title="이 화면을 보내 주는 PC">
        강사 화면 공유 중{via && via !== '이 PC' ? ` · ${via} 경유` : ''}
      </span>
    </>
  );
}

/** Student: back to the shared screen from the 교안. */
export function WatchScreenButton() {
  return (
    <button className="pill-btn live" onClick={() => useStore.setState({ screenView: true })} title="강사가 공유 중인 화면 보기">
      <MonitorUp size={14} /> 공유 화면 보기 <span className="dot" />
    </button>
  );
}

const watchers = (nodes: ScreenNode[] = []) => nodes.reduce((n, node) => n + node.viewers, 0);

/** Teacher: start sharing, or the live indicator that opens the sharing panel. */
export function ScreenShareButton() {
  const sharing = useStore((s) => !!s.myShare);
  const error = useStore((s) => s.screen.error);
  const count = useStore((s) => watchers(s.screen.nodes));
  const [panel, setPanel] = useState(false);
  const [relays, setRelays] = useState(false);

  return (
    <>
      {sharing ? (
        <button className="pill-btn live" onClick={() => setPanel(true)} title="화면 공유 상태와 릴레이 PC">
          <span className="dot" /> 화면 공유 중 · {count}명
        </button>
      ) : (
        <Menu
          title={error || '화면 공유'}
          className="pill-btn"
          button={
            <>
              <MonitorUp size={14} /> 화면 공유
            </>
          }
          items={[
            { icon: <Type size={14} />, label: '공유 시작 · 글자·코드 선명하게', onClick: () => void startSharing(false), disabled: !!error },
            { icon: <Clapperboard size={14} />, label: '공유 시작 · 동영상 부드럽게', onClick: () => void startSharing(true), disabled: !!error },
            { icon: <Network size={14} />, label: '릴레이 PC 연결 방법', onClick: () => setRelays(true) },
          ]}
          hint={
            error ||
            '화면은 한 번만 인코딩되고, 서버가 학생마다 복사해 보내요. 학생이 많으면 남는 PC를 릴레이로 연결해 나눠 보낼 수 있어요.'
          }
        />
      )}
      {panel && sharing && (
        <SharePanel
          onClose={() => setPanel(false)}
          onRelays={() => {
            setPanel(false);
            setRelays(true);
          }}
        />
      )}
      {relays && <RelayDialog onClose={() => setRelays(false)} />}
    </>
  );
}

function SharePanel({ onClose, onRelays }: { onClose: () => void; onRelays: () => void }) {
  const share = useStore((s) => s.myShare);
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = share?.stream ?? null;
  }, [share?.stream]);
  if (!share) return null;

  return (
    <Modal
      title="화면 공유 중"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onRelays}>
            <Network size={14} /> 릴레이 PC 연결 방법
          </button>
          <button
            className="btn danger"
            onClick={() => {
              stopSharing();
              onClose();
            }}
          >
            공유 중지
          </button>
        </>
      }
    >
      <video ref={ref} className="screen-preview" autoPlay muted playsInline />
      <div className="screen-mode" role="radiogroup" aria-label="공유 방식">
        <button className={`btn small ${share.motion ? '' : 'active'}`} role="radio" aria-checked={!share.motion} onClick={() => void setShareMotion(false)}>
          <Type size={14} /> 글자·코드 선명하게
        </button>
        <button className={`btn small ${share.motion ? 'active' : ''}`} role="radio" aria-checked={share.motion} onClick={() => void setShareMotion(true)}>
          <Clapperboard size={14} /> 동영상 부드럽게
        </button>
      </div>
      <p className="muted small">
        {share.codec
          ? `인코딩: ${share.codec} · ${share.hardware ? '그래픽 칩(하드웨어)이 처리해 CPU 부담이 적어요' : '소프트웨어(CPU)로 처리해요'}. 학생 수와 상관없이 한 번만 인코딩해요.`
          : '연결하는 중…'}
      </p>
      <NodeList />
    </Modal>
  );
}

/** The PCs that send the screen to students, and how many students each one serves. */
function NodeList() {
  const nodes = useStore((s) => s.screen.nodes ?? []);
  return (
    <table className="screen-nodes">
      <thead>
        <tr>
          <th>보내는 PC</th>
          <th>주소</th>
          <th>학생</th>
        </tr>
      </thead>
      <tbody>
        {nodes.map((n) => (
          <tr key={n.id}>
            <td>
              {n.name}
              {n.relay && <span className="muted small"> · 릴레이</span>}
            </td>
            <td className="mono small">{n.address}</td>
            <td title={`${n.seats}명까지 이 PC에 먼저 배정해요`}>
              <meter min={0} max={n.seats} value={Math.min(n.viewers, n.seats)} /> {n.viewers}
              <span className="muted small"> / {n.seats}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RelayDialog({ onClose }: { onClose: () => void }) {
  const [info, setInfo] = useState<RelayInfo | null>(null);
  const relays = useStore((s) => (s.screen.nodes ?? []).filter((n) => n.relay).length);
  useEffect(() => {
    void send<RelayInfo>('screen:relay-info', {}).then((res) => res.ok && setInfo(res.data));
  }, []);
  const command = info ? `run-relay.bat ${publicOrigin()} ${info.key}` : '';

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast('복사했어요.');
    } catch {
      prompt('복사하세요', text);
    }
  }

  return (
    <Modal title="릴레이 PC 연결" onClose={onClose} size="wide">
      <div className="relay-help">
        <p>
          남는 PC가 강사 화면을 받아 일부 학생에게 대신 보내요. 학생은 지금 주소 그대로 접속하고, 서버가 자리가 많이
          남은 PC로 자동 배정해요. 릴레이 PC가 꺼지면 그 학생들은 다른 PC로 자동으로 옮겨져요.
        </p>
        <ol>
          <li>
            이 PC에서 <code>npm run relay:bundle</code>을 한 번 실행하면 <code>relay-bundle</code> 폴더가 생겨요. Node.js가
            들어 있어 설치 없이 돌아가요. 이 폴더를 남는 PC에 복사하세요 (USB·공유 폴더).
          </li>
          <li>
            남는 PC에서 <code>firewall.bat</code>을 한 번 실행해 방화벽을 열어 주세요 (관리자 권한 필요. 회사 PC는 IT
            담당자에게 요청해야 할 수 있어요). 이 PC에도 한 번 필요해요.
          </li>
          <li>
            <code>run-relay.bat</code>을 실행하고 아래 주소와 키를 넣으세요. 또는 명령 한 줄:
            {command ? (
              <div className="copy-line">
                <code className="mono">{command}</code>
                <button className="icon-btn" title="복사" aria-label="명령 복사" onClick={() => void copy(command)}>
                  <Copy size={14} />
                </button>
              </div>
            ) : (
              <p className="muted small">불러오는 중…</p>
            )}
          </li>
        </ol>
        {info && (
          <p className="muted small">
            이 PC 주소: {info.urls.join(', ') || '없음'} · 릴레이 PC 키: <span className="mono">{info.key}</span> (키는
            강사에게만 보여요)
          </p>
        )}
        <h3>연결된 PC {relays ? `(릴레이 ${relays}대)` : '(아직 릴레이 없음)'}</h3>
        <NodeList />
      </div>
    </Modal>
  );
}
