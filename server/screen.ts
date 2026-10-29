// 화면 공유. The teacher's browser encodes its screen once and sends it here, and mediasoup copies
// the packets to each student (an SFU), so the teacher's PC encodes once however many watch.
// Relay PCs (server/relay.ts) can take part of the class: the screen is piped to a relay once,
// and each student who joins is sent to the PC with the most free seats. Students always open
// this server's address; if they can't get the screen through a relay, they ask for another PC.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { types } from 'mediasoup';
import type { Server, Socket } from 'socket.io';
import type { z } from 'zod';
import type { RelayInfo, ScreenNode, ScreenState } from '../shared/protocol.ts';
import type { SessionUser } from './auth.ts';
import { config } from './config.ts';
import { UserError } from './errors.ts';
import { findPrimaryAddress, lanAddresses, MediaHost, plainIp, type RpcMethod, type TransportInfo } from './media.ts';
import * as S from './schemas.ts';

/** A PC that sends the screen to students: this one, or a relay. */
interface MediaNode {
  id: string;
  name: string;
  address: string;
  seats: number;
  /** Socket ids of the students watching through this PC. */
  viewers: Set<string>;
  /** Calls a MediaHost method on that PC. */
  call: <M extends RpcMethod>(method: M, ...args: Parameters<MediaHost[M]>) => Promise<Awaited<ReturnType<MediaHost[M]>>>;
  /** Relays: this server's address as the relay reaches it, where this end of a pipe listens. */
  originIp?: string;
}

interface Share {
  room: string;
  /** Socket.IO channel of the class. */
  channel: string;
  teacherSocket: string;
  transportId: string;
  producer: types.Producer | null;
  /** Relays the screen is piped to: node id → id of this PC's end of the pipe. */
  pipes: Map<string, Promise<string>>;
}

interface Viewer {
  room: string;
  node: MediaNode;
  transportId: string;
  consumerId?: string;
}

const ORIGIN = 'origin';
/** Channel of every teacher socket, for the list of PCs and their students. */
const TEACHERS = 'screen:teachers';

let io: Server;
let host: MediaHost | null = null;
let hostError = '';
let relayKey = '';
const nodes = new Map<string, MediaNode>();
/** By room code. */
const shares = new Map<string, Share>();
/** By socket id. */
const viewers = new Map<string, Viewer>();

/** This server's page on each LAN address, the likeliest one for students first. */
export const serverUrls = () => lanAddresses().map((ip) => `http://${ip}:${config.port}`);

export async function setupScreen(server: Server) {
  io = server;
  await findPrimaryAddress();
  if (!config.screen.enabled) {
    hostError = '서버 설정에서 화면 공유가 꺼져 있어요 (SCREEN_SHARE=off).';
    return;
  }
  relayKey = loadRelayKey();
  await startHost();
  acceptRelays();
}

/** One line for the startup log. */
export function screenSummary(): string {
  if (!host) return `off (${hostError})`;
  return `on (UDP·TCP ${config.screen.port}) · 릴레이 PC 키 ${relayKey}`;
}

function loadRelayKey(): string {
  if (config.screen.relayKey) return config.screen.relayKey;
  const file = path.join(config.dataDir, 'relay.key');
  try {
    const saved = fs.readFileSync(file, 'utf8').trim();
    if (saved) return saved;
  } catch {
    // First run: make one.
  }
  const key = crypto.randomBytes(9).toString('base64url');
  fs.writeFileSync(file, key);
  return key;
}

async function startHost() {
  const ips = config.screen.ips.length ? config.screen.ips : lanAddresses();
  try {
    const h = await MediaHost.start(config.screen.port, ips);
    host = h;
    hostError = '';
    nodes.set(ORIGIN, {
      id: ORIGIN,
      name: '이 PC',
      address: ips.join(', '),
      seats: config.screen.directSeats,
      viewers: new Set(),
      call: (method, ...args) => (h[method] as (...a: unknown[]) => Promise<never>).apply(h, args),
    });
    h.worker.on('died', (err) => {
      console.error('[화면 공유] mediasoup이 멈췄어요. 2초 후 다시 시작합니다.', err);
      host = null;
      hostError = '화면 공유 서버를 다시 시작하는 중이에요.';
      for (const room of [...shares.keys()]) end(room);
      nodes.delete(ORIGIN);
      setTimeout(() => void startHost(), 2000);
    });
  } catch (err) {
    hostError = `화면 공유 포트 ${config.screen.port}을(를) 열지 못했어요: ${(err as Error).message}`;
    console.error(`[화면 공유] ${hostError}`);
  }
  emitNodes();
}

// ---- relay PCs ----

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function acceptRelays() {
  const nsp = io.of('/relay');
  nsp.use((socket, next) => {
    const auth = S.relayAuthSchema.safeParse(socket.handshake.auth);
    if (!auth.success || !safeEqual(auth.data.key, relayKey)) return next(new Error('wrong relay key'));
    socket.data.relay = auth.data;
    next();
  });
  nsp.on('connection', (socket) => {
    const { name, seats } = socket.data.relay as z.infer<typeof S.relayAuthSchema>;
    const node: MediaNode = {
      id: `relay:${socket.id}`,
      name: uniqueName(name),
      address: plainIp(socket.handshake.address),
      seats,
      viewers: new Set(),
      originIp: plainIp(socket.request.socket.localAddress ?? ''),
      call: async (method, ...args) => {
        const res = await socket.timeout(15_000).emitWithAck('rpc', method, args);
        if (!res?.ok) throw new Error(`${method} on relay: ${res?.error ?? 'no answer'}`);
        return res.data;
      },
    };
    nodes.set(node.id, node);
    console.log(`  [화면 공유] 릴레이 PC 연결됨: ${node.name} (${node.address}, ${seats}석)`);
    emitNodes();
    socket.on('disconnect', (reason) => {
      console.log(`  [화면 공유] 릴레이 PC 연결 끊김: ${node.name} (${reason})`);
      dropNode(node);
    });
  });
}

function uniqueName(name: string) {
  const taken = new Set([...nodes.values()].map((n) => n.name));
  let unique = name;
  for (let i = 2; taken.has(unique); i++) unique = `${name} (${i})`;
  return unique;
}

function dropNode(node: MediaNode) {
  nodes.delete(node.id);
  for (const share of shares.values()) {
    const pipe = share.pipes.get(node.id);
    share.pipes.delete(node.id);
    pipe?.then((id) => host?.closeTransport(id), () => {});
  }
  // Its students get the screen again through another PC.
  for (const socketId of node.viewers) {
    viewers.delete(socketId);
    io.to(socketId).emit('screen:moved');
  }
  node.viewers.clear();
  emitNodes();
}

/** Students per seat once one more joins. A relay's pipe costs the teacher's PC about one student. */
function loadWithOneMore(node: MediaNode) {
  let n = node.viewers.size + 1;
  if (node.id === ORIGIN) for (const s of shares.values()) n += s.pipes.size;
  return n / node.seats;
}

function pick(exclude: string[]): MediaNode {
  const origin = nodes.get(ORIGIN)!;
  const candidates = [...nodes.values()].filter((n) => !exclude.includes(n.id));
  // Most free seats wins. On a tie a relay does, so the teacher's PC keeps the overflow.
  return candidates.reduce<MediaNode>((best, n) => {
    const d = loadWithOneMore(n) - loadWithOneMore(best);
    return d < 0 || (d === 0 && best === origin) ? n : best;
  }, candidates[0] ?? origin);
}

/** Pipes the screen to a relay, once per relay; later students of that relay reuse the pipe. */
function ensurePipe(share: Share, node: MediaNode): Promise<string> {
  let pipe = share.pipes.get(node.id);
  if (pipe) return pipe;
  const h = host!;
  const producer = share.producer!;
  pipe = (async () => {
    const local = await h.openPipe(share.room, node.originIp!);
    try {
      const remote = await node.call('openPipe', share.room, node.address);
      await node.call('connectPipe', remote.id, local);
      await h.connectPipe(local.id, remote);
      const stream = await h.pipeConsume(local.id, producer.id);
      await node.call('pipeProduce', remote.id, producer.id, stream);
      return local.id;
    } catch (err) {
      void h.closeTransport(local.id);
      throw err;
    }
  })();
  share.pipes.set(node.id, pipe);
  pipe.catch(() => share.pipes.get(node.id) === pipe && share.pipes.delete(node.id));
  emitNodes();
  return pipe;
}

// ---- sharing (teacher) ----

async function start(socketId: string, room: string, channel: string) {
  if (!host) throw new UserError(hostError || '화면 공유를 쓸 수 없어요.');
  end(room); // e.g. still sharing from another tab
  const routerRtpCapabilities = await host.capabilities(room);
  const transport = await host.createTransport(room);
  shares.set(room, { room, channel, teacherSocket: socketId, transportId: transport.id, producer: null, pipes: new Map() });
  return { routerRtpCapabilities, transport };
}

async function produce(
  socketId: string,
  room: string,
  { transportId, kind, rtpParameters }: z.infer<typeof S.screenProduceSchema>,
) {
  const share = shares.get(room);
  if (!host || share?.teacherSocket !== socketId || share.transportId !== transportId || share.producer)
    throw new UserError('화면 공유를 다시 시작하세요.');
  const producer = await host.produce(transportId, kind, rtpParameters as types.RtpParameters);
  if (shares.get(room) !== share) {
    producer.close();
    throw new UserError('화면 공유가 끝났어요.');
  }
  share.producer = producer;
  console.log(`  [화면 공유] 시작: 수업 ${room}, ${producer.rtpParameters.codecs[0]?.mimeType}`);
  io.to(share.channel).emit('screen', { live: true } satisfies ScreenState);
  return { id: producer.id };
}

function end(room: string) {
  const share = shares.get(room);
  if (!share) return;
  shares.delete(room);
  for (const [socketId, v] of viewers) {
    if (v.room !== room) continue;
    viewers.delete(socketId);
    v.node.viewers.delete(socketId);
  }
  // Closing the router closes every transport, stream and pipe of this class.
  void host?.closeRoom(room);
  for (const node of nodes.values()) if (node.id !== ORIGIN) node.call('closeRoom', room).catch(() => {});
  if (share.producer) console.log(`  [화면 공유] 끝: 수업 ${room}`);
  io.to(share.channel).emit('screen', { live: false } satisfies ScreenState);
  emitNodes();
}

// ---- watching (students) ----

async function join(socket: Socket, room: string, exclude: string[]) {
  const share = shares.get(room);
  if (!share?.producer) throw new UserError('강사가 화면을 공유하고 있지 않아요.');
  leave(socket.id);
  const tried = [...exclude];
  for (;;) {
    const node = pick(tried);
    // Hold the seat now: when sharing starts, the whole class joins at once and would otherwise
    // all see the same counts and pick the same PC.
    node.viewers.add(socket.id);
    let transport: TransportInfo;
    let routerRtpCapabilities: types.RtpCapabilities;
    try {
      if (node.id !== ORIGIN) await ensurePipe(share, node);
      [routerRtpCapabilities, transport] = await Promise.all([node.call('capabilities', room), node.call('createTransport', room)]);
    } catch (err) {
      node.viewers.delete(socket.id);
      if (node.id === ORIGIN) throw err;
      console.warn(`  [화면 공유] ${node.name} 경유 실패, 다른 PC로 연결해요:`, (err as Error).message);
      tried.push(node.id);
      continue;
    }
    // The share ended, the student left, or the PC went away while this was being set up.
    if (shares.get(room) !== share || !socket.connected || nodes.get(node.id) !== node) {
      node.viewers.delete(socket.id);
      node.call('closeTransport', transport.id).catch(() => {});
      throw new UserError('화면 공유 연결이 바뀌었어요. 다시 연결해요.');
    }
    // A second join from this browser raced this one: keep the newer.
    const previous = viewers.get(socket.id);
    if (previous) {
      if (previous.node !== node) previous.node.viewers.delete(socket.id);
      previous.node.call('closeTransport', previous.transportId).catch(() => {});
    }
    viewers.set(socket.id, { room, node, transportId: transport.id });
    node.viewers.add(socket.id);
    emitNodes();
    return { nodeId: node.id, nodeName: node.name, routerRtpCapabilities, transport };
  }
}

function leave(socketId: string) {
  const v = viewers.get(socketId);
  if (!v) return;
  viewers.delete(socketId);
  v.node.viewers.delete(socketId);
  v.node.call('closeTransport', v.transportId).catch(() => {});
  emitNodes();
}

async function connect(socketId: string, room: string, transportId: string, dtlsParameters: types.DtlsParameters) {
  const v = viewers.get(socketId);
  if (v?.transportId === transportId) return v.node.call('connectTransport', transportId, dtlsParameters);
  const share = shares.get(room);
  if (host && share?.teacherSocket === socketId && share.transportId === transportId)
    return host.connectTransport(transportId, dtlsParameters);
  throw new UserError('화면 공유 연결이 끊겼어요. 다시 연결해요.');
}

async function consume(socketId: string, transportId: string, rtpCapabilities: types.RtpCapabilities) {
  const v = viewers.get(socketId);
  const producer = v && shares.get(v.room)?.producer;
  if (!v || v.transportId !== transportId || !producer) throw new UserError('화면 공유 연결이 끊겼어요. 다시 연결해요.');
  const info = await v.node.call('consume', transportId, producer.id, rtpCapabilities);
  v.consumerId = info.id;
  return info;
}

// ---- state for clients ----

function nodeList(): ScreenNode[] {
  return [...nodes.values()].map((n) => ({
    id: n.id,
    name: n.name,
    address: n.address,
    relay: n.id !== ORIGIN,
    viewers: n.viewers.size,
    seats: n.seats,
  }));
}

let nodesTimer: ReturnType<typeof setTimeout> | null = null;
/** Sends teachers the PCs and their student counts; bursts (a class joining) become one update. */
function emitNodes() {
  if (nodesTimer || !io) return;
  nodesTimer = setTimeout(() => {
    nodesTimer = null;
    io.to(TEACHERS).emit('screen:nodes', { nodes: nodeList(), error: hostError });
  }, 200);
}

export function screenState(room: string, isTeacher: boolean): ScreenState {
  const live = !!shares.get(room)?.producer;
  return isTeacher ? { live, error: hostError, nodes: nodeList() } : { live };
}

type Handle = <T extends z.ZodType>(
  event: string,
  schema: T,
  fn: (data: z.infer<T>) => unknown,
  opts?: { teacherOnly?: boolean },
) => void;

/** Socket events of 화면 공유. `channel` is the class's Socket.IO channel. */
export function screenEvents(socket: Socket, user: SessionUser, channel: string, handle: Handle) {
  const room = user.roomCode;
  if (user.role === 'teacher') socket.join(TEACHERS);

  handle('screen:start', S.noArgsSchema, () => start(socket.id, room, channel), { teacherOnly: true });
  handle('screen:produce', S.screenProduceSchema, (data) => produce(socket.id, room, data), { teacherOnly: true });
  handle('screen:stop', S.noArgsSchema, () => end(room), { teacherOnly: true });
  handle(
    'screen:relay-info',
    S.noArgsSchema,
    (): RelayInfo => ({ key: relayKey, urls: serverUrls() }),
    { teacherOnly: true },
  );

  handle('screen:join', S.screenJoinSchema, ({ exclude }) => join(socket, room, exclude));
  handle('screen:connect', S.screenConnectSchema, ({ transportId, dtlsParameters }) =>
    connect(socket.id, room, transportId, dtlsParameters as types.DtlsParameters),
  );
  handle('screen:consume', S.screenConsumeSchema, ({ transportId, rtpCapabilities }) =>
    consume(socket.id, transportId, rtpCapabilities as types.RtpCapabilities),
  );
  handle('screen:resume', S.screenResumeSchema, async ({ consumerId }) => {
    const v = viewers.get(socket.id);
    if (v?.consumerId === consumerId) await v.node.call('resume', consumerId);
  });
  handle('screen:leave', S.noArgsSchema, () => leave(socket.id));

  socket.on('disconnect', () => {
    leave(socket.id);
    if (shares.get(room)?.teacherSocket === socket.id) end(room);
  });
}
