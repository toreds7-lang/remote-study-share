// Relay PC for 화면 공유. Run it on a spare PC on the same network to take part of the class off
// the teacher's PC: it connects to the teacher's StudyShare server, receives the screen once
// through a pipe, and sends it to the students the server assigns to it. Students open nothing
// here; they keep using the teacher's address, and the server decides who goes through which PC.
//
//   node server/relay.ts --origin http://10.0.0.5:3000 --key <릴레이 PC 키> [--name 강의실-2] [--seats 30]
//
// Options can also come from the environment: ORIGIN, RELAY_KEY, RELAY_NAME, RELAY_SEATS,
// SCREEN_PORT (default 3001; UDP·TCP, plus the 99 UDP ports after it) and SCREEN_IP.

import os from 'node:os';
import { parseArgs } from 'node:util';
import { io } from 'socket.io-client';
import { lanAddresses, MediaHost, RPC_METHODS, type RpcMethod } from './media.ts';

const { values: arg } = parseArgs({
  options: {
    origin: { type: 'string' },
    key: { type: 'string' },
    name: { type: 'string' },
    seats: { type: 'string' },
    port: { type: 'string' },
    ip: { type: 'string' },
  },
});

const origin = arg.origin || process.env.ORIGIN || '';
const key = arg.key || process.env.RELAY_KEY || '';
const name = (arg.name || process.env.RELAY_NAME || os.hostname()).slice(0, 40);
const seats = Math.max(1, Math.round(Number(arg.seats || process.env.RELAY_SEATS || 30)) || 30);
const port = Number(arg.port || process.env.SCREEN_PORT || 3001);
const ips = (arg.ip ?? process.env.SCREEN_IP ?? '').split(',').map((s) => s.trim()).filter(Boolean);

if (!/^https?:\/\//.test(origin) || !key) {
  console.error('사용법: relay --origin http://<강사 PC 주소>:3000 --key <릴레이 PC 키> [--name 이름] [--seats 30]');
  console.error('강사 화면의 [화면 공유 → 릴레이 PC 연결 방법]에 주소와 키가 나와 있어요.');
  process.exit(1);
}

const listen = ips.length ? ips : lanAddresses();
const host = await MediaHost.start(port, listen).catch((err: Error) => {
  console.error(`포트 ${port}을(를) 열지 못했어요: ${err.message}`);
  console.error('다른 프로그램이 쓰고 있으면 --port 로 다른 번호를 주세요.');
  process.exit(1);
});
// Exit codes for run-relay.bat: 1 = fix the settings, 2 = wrong key, 3 = start again.
host.worker.on('died', () => {
  console.error('mediasoup이 멈췄어요. 릴레이를 다시 시작해요.');
  process.exit(3);
});

const socket = io(new URL('/relay', origin).href, {
  transports: ['websocket'],
  auth: { key, name, seats },
});

let shown = -1;
function showViewers() {
  const n = host.viewerCount();
  if (n !== shown) console.log(`  학생 ${n}명이 이 PC를 거쳐 보고 있어요.`);
  shown = n;
}

socket.on('connect', () => {
  console.log(`\n  릴레이 PC "${name}" 연결됨 → ${origin}`);
  console.log(`  학생용 주소: ${listen.join(', ')} (UDP·TCP ${port}) · 최대 ${seats}명 우선 배정`);
  console.log('  이 창을 닫으면 릴레이가 멈추고, 이 PC의 학생들은 다른 PC로 자동으로 옮겨져요.\n');
});
socket.on('connect_error', (err) => {
  if (err.message === 'wrong relay key') {
    console.error('릴레이 PC 키가 틀려요. 강사 화면에서 키를 다시 확인하세요.');
    process.exit(2);
  }
  console.warn(`  ${origin}에 연결하지 못했어요 (${err.message}). 다시 시도하는 중…`);
});
socket.on('disconnect', (reason) => {
  console.warn(`  연결이 끊겼어요 (${reason}). 다시 연결하는 중…`);
  // The server forgets this PC's pipes and students; start clean when it comes back.
  void host.closeAll().then(showViewers);
});

socket.on('rpc', async (method: string, args: unknown, ack: (res: unknown) => void) => {
  if (typeof ack !== 'function') return;
  if (!RPC_METHODS.includes(method as RpcMethod) || !Array.isArray(args)) return ack({ ok: false, error: 'unknown call' });
  try {
    const fn = host[method as RpcMethod] as (...a: unknown[]) => Promise<unknown>;
    ack({ ok: true, data: await fn.apply(host, args) });
  } catch (err) {
    ack({ ok: false, error: (err as Error).message });
  }
  if (method === 'createTransport' || method === 'closeTransport' || method === 'closeRoom') showViewers();
});
