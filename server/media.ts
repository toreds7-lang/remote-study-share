// mediasoup, shared by the teacher's server (screen.ts) and relay PCs (relay.ts). It forwards RTP
// packets without decoding them: the screen is encoded once, in the teacher's browser, and each
// PC only copies packets to its viewers. A PC passes the stream to a relay through a pipe (plain
// RTP over UDP, encrypted with SRTP), so every hop still carries one copy.
//
// This file must stay plain enough for Node's type stripping (no enums, no parameter properties),
// because the relay bundle runs it without a build step.

import dgram from 'node:dgram';
import os from 'node:os';
import * as mediasoup from 'mediasoup';
import type { types } from 'mediasoup';

/** Every router offers the same codecs, so a stream can be piped from one PC to another. */
const MEDIA_CODECS: types.RouterRtpCodecCapability[] = [
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000 },
  { kind: 'video', mimeType: 'video/VP9', clockRate: 90000, parameters: { 'profile-id': 0 } },
  {
    kind: 'video',
    mimeType: 'video/H264',
    clockRate: 90000,
    parameters: { 'packetization-mode': 1, 'profile-level-id': '42e01f', 'level-asymmetry-allowed': 1 },
  },
];

/** What a browser needs to open a WebRTC transport to this PC. */
export interface TransportInfo {
  id: string;
  iceParameters: types.IceParameters;
  iceCandidates: types.IceCandidate[];
  dtlsParameters: types.DtlsParameters;
}

export interface ConsumerInfo {
  id: string;
  producerId: string;
  kind: types.MediaKind;
  rtpParameters: types.RtpParameters;
}

/** One end of a pipe between two PCs. */
export interface PipeEnd {
  id: string;
  ip: string;
  port: number;
  srtpParameters: types.SrtpParameters;
}

/** The stream leaving the teacher's PC through a pipe, as the relay must re-create it. */
export interface PipedStream {
  kind: types.MediaKind;
  rtpParameters: types.RtpParameters;
  paused: boolean;
}

/** Adapters other PCs can't reach this one through: WSL, Hyper-V, VM host-only networks, VPNs. */
const VIRTUAL_ADAPTER = /vethernet|wsl|hyper-v|virtualbox|vmware|docker|vpn|tailscale|zerotier|bluetooth/i;
let primaryAddress = '';

/** Learns the address of the default route (the real network card), to list it first. Sends nothing. */
export async function findPrimaryAddress(): Promise<void> {
  const socket = dgram.createSocket('udp4');
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.connect(53, '8.8.8.8', resolve);
    });
    primaryAddress = socket.address().address;
  } catch {
    // No default route, e.g. a classroom network without internet: fall back on adapter names.
  } finally {
    socket.close();
  }
}

/** This PC's IPv4 addresses that other PCs may reach (no loopback or link-local), likeliest first. */
export function lanAddresses(): string[] {
  const rank = ({ name, address }: { name: string; address: string }) =>
    VIRTUAL_ADAPTER.test(name) ? 2 : address === primaryAddress ? 0 : 1;
  const found = Object.entries(os.networkInterfaces())
    .flatMap(([name, list]) =>
      (list ?? [])
        .filter((i) => i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.'))
        .map((i) => ({ name, address: i.address })),
    )
    .sort((a, b) => rank(a) - rank(b));
  return found.length ? found.map((f) => f.address) : ['127.0.0.1'];
}

/** `::ffff:10.0.0.5` → `10.0.0.5`. */
export const plainIp = (address: string) => address.replace(/^::ffff:/, '');

/** Methods the teacher's server calls on a relay over its socket (and on its own host directly). */
export const RPC_METHODS = [
  'capabilities',
  'createTransport',
  'connectTransport',
  'consume',
  'resume',
  'closeTransport',
  'closeRoom',
  'openPipe',
  'connectPipe',
  'pipeProduce',
] as const;
export type RpcMethod = (typeof RPC_METHODS)[number];

export class MediaHost {
  worker: types.Worker;
  private server: types.WebRtcServer;
  /** UDP ports for pipes to and from other PCs: the 99 ports after the WebRTC port. */
  private pipePorts: types.TransportPortRange;
  private routers = new Map<string, Promise<types.Router>>();
  private transports = new Map<string, types.Transport>();
  private consumers = new Map<string, types.Consumer>();

  private constructor(worker: types.Worker, server: types.WebRtcServer, port: number) {
    this.worker = worker;
    this.server = server;
    this.pipePorts = { min: port + 1, max: port + 99 };
  }

  /**
   * Starts a mediasoup worker. Viewers reach it on `port` of each address in `ips`, over UDP or,
   * where a network blocks UDP, over TCP on the same port.
   */
  static async start(port: number, ips: string[]): Promise<MediaHost> {
    const worker = await mediasoup.createWorker({ logLevel: 'warn' });
    try {
      const server = await worker.createWebRtcServer({
        listenInfos: ips.flatMap((ip) => (['udp', 'tcp'] as const).map((protocol) => ({ protocol, ip, port }))),
      });
      return new MediaHost(worker, server, port);
    } catch (err) {
      worker.close();
      throw err;
    }
  }

  close() {
    this.worker.close();
  }

  /** Students connected to this PC. */
  viewerCount(): number {
    return [...this.transports.values()].filter((t) => t.appData.viewer).length;
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.routers.keys()].map((room) => this.closeRoom(room)));
  }

  private router(room: string): Promise<types.Router> {
    let router = this.routers.get(room);
    if (!router) {
      router = this.worker.createRouter({ mediaCodecs: MEDIA_CODECS });
      this.routers.set(room, router);
      router.catch(() => this.routers.get(room) === router && this.routers.delete(room));
    }
    return router;
  }

  private keep<T extends types.Transport>(transport: T): T {
    this.transports.set(transport.id, transport);
    transport.observer.on('close', () => this.transports.delete(transport.id));
    return transport;
  }

  private transport(id: string): types.Transport {
    const transport = this.transports.get(id);
    if (!transport) throw new Error(`transport ${id} is closed`);
    return transport;
  }

  async capabilities(room: string): Promise<types.RtpCapabilities> {
    return (await this.router(room)).rtpCapabilities;
  }

  async createTransport(room: string): Promise<TransportInfo> {
    const router = await this.router(room);
    const t = this.keep(
      await router.createWebRtcTransport({
        webRtcServer: this.server,
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
        appData: { room, viewer: true },
      }),
    );
    return { id: t.id, iceParameters: t.iceParameters, iceCandidates: t.iceCandidates, dtlsParameters: t.dtlsParameters };
  }

  async connectTransport(id: string, dtlsParameters: types.DtlsParameters): Promise<void> {
    await this.transport(id).connect({ dtlsParameters });
  }

  /** The teacher's screen arriving from the browser. Only the teacher's server calls this. */
  async produce(transportId: string, kind: types.MediaKind, rtpParameters: types.RtpParameters): Promise<types.Producer> {
    // 30 students joining at once each ask for a key frame; one per second is plenty.
    return this.transport(transportId).produce({ kind, rtpParameters, keyFrameRequestDelay: 1000 });
  }

  /** Starts paused, so no packets are wasted before the browser is ready; see resume(). */
  async consume(transportId: string, producerId: string, rtpCapabilities: types.RtpCapabilities): Promise<ConsumerInfo> {
    const transport = this.transport(transportId);
    const router = await this.router(transport.appData.room as string);
    if (!router.canConsume({ producerId, rtpCapabilities })) throw new Error('this browser cannot decode the stream');
    const consumer = await transport.consume({ producerId, rtpCapabilities, paused: true });
    this.consumers.set(consumer.id, consumer);
    consumer.observer.on('close', () => this.consumers.delete(consumer.id));
    return { id: consumer.id, producerId, kind: consumer.kind, rtpParameters: consumer.rtpParameters };
  }

  async resume(consumerId: string): Promise<void> {
    await this.consumers.get(consumerId)?.resume();
  }

  async closeTransport(id: string): Promise<void> {
    this.transports.get(id)?.close();
  }

  /** Ends everything of one class: its router, and with it every transport, stream and pipe. */
  async closeRoom(room: string): Promise<void> {
    const router = this.routers.get(room);
    this.routers.delete(room);
    (await router?.catch(() => null))?.close();
  }

  /** Opens this PC's end of a pipe on `ip`, the address the other PC reaches it at. */
  async openPipe(room: string, ip: string): Promise<PipeEnd> {
    const router = await this.router(room);
    const t = this.keep(
      await router.createPipeTransport({
        listenInfo: { protocol: 'udp', ip, portRange: this.pipePorts },
        // Retransmit lost packets between PCs, and keep the screen encrypted on the wire.
        enableRtx: true,
        enableSrtp: true,
        appData: { room },
      }),
    );
    return { id: t.id, ip, port: t.tuple.localPort, srtpParameters: t.srtpParameters! };
  }

  async connectPipe(id: string, { ip, port, srtpParameters }: Omit<PipeEnd, 'id'>): Promise<void> {
    await (this.transport(id) as types.PipeTransport).connect({ ip, port, srtpParameters });
  }

  /** Teacher's PC: sends the screen into a pipe. */
  async pipeConsume(id: string, producerId: string): Promise<PipedStream> {
    const consumer = await (this.transport(id) as types.PipeTransport).consume({ producerId });
    return { kind: consumer.kind, rtpParameters: consumer.rtpParameters, paused: consumer.producerPaused };
  }

  /** Relay: the screen coming out of a pipe, under the producer id that viewers ask for. */
  async pipeProduce(id: string, producerId: string, stream: PipedStream): Promise<void> {
    await this.transport(id).produce({ id: producerId, ...stream });
  }
}
