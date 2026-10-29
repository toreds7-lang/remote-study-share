// 화면 공유 in the browser.
// Teacher: captures a screen or window and sends it once, to the server, which copies it to every
// student. Student: receives it from the PC the server picks (the teacher's PC or a relay PC) and,
// if no picture comes through that PC, asks the server for another one.

import { Device } from 'mediasoup-client';
import type { types } from 'mediasoup-client';
import { request, socket } from './socket.ts';
import { toast, useStore } from './store.ts';

interface StartReply {
  routerRtpCapabilities: types.RtpCapabilities;
  transport: types.TransportOptions;
}
interface JoinReply extends StartReply {
  nodeId: string;
  nodeName: string;
}
interface ConsumeReply {
  id: string;
  producerId: string;
  kind: 'video';
  rtpParameters: types.RtpParameters;
}

/** Text and code stay sharp at a low frame rate; video gets more frames and bits. */
const MODES = {
  detail: { frameRate: 15, maxBitrate: 2_500_000 },
  motion: { frameRate: 30, maxBitrate: 5_000_000 },
};

// ---- teacher ----

interface Sending {
  stream: MediaStream;
  motion: boolean;
  transport?: types.Transport;
  producer?: types.Producer;
}
let sending: Sending | null = null;
/** Bumped to cancel a publish() that is still in progress. */
let publishGen = 0;

export async function startSharing(motion: boolean) {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    toast('이 주소에서는 화면을 공유할 수 없어요. 강사 PC에서 http://localhost 주소로 열어 주세요.', 6000);
    return;
  }
  const mode = motion ? MODES.motion : MODES.detail;
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: mode.frameRate, max: 30 }, width: { max: 1920 }, height: { max: 1080 } },
      audio: false,
    });
  } catch {
    return; // the teacher cancelled the picker
  }
  stopSharing();
  const track = stream.getVideoTracks()[0];
  track.contentHint = motion ? 'motion' : 'detail';
  // The browser's own "공유 중지" bar ends the track.
  track.addEventListener('ended', () => sending?.stream === stream && stopSharing());
  sending = { stream, motion };
  useStore.setState({ myShare: { stream, motion, codec: '', hardware: false } });
  await publish();
}

/** Sends the captured screen to the server; again after a reconnect, as the server ended it. */
async function publish() {
  const share = sending;
  if (!share) return;
  const gen = ++publishGen;
  share.transport?.close();
  try {
    const { routerRtpCapabilities, transport } = await request<StartReply>('screen:start', {});
    const device = new Device();
    await device.load({ routerRtpCapabilities });
    if (gen !== publishGen) return;
    const t = device.createSendTransport(transport);
    share.transport = t;
    t.on('connect', ({ dtlsParameters }, ok, fail) => {
      request('screen:connect', { transportId: t.id, dtlsParameters }).then(ok, fail);
    });
    t.on('produce', ({ kind, rtpParameters }, ok, fail) => {
      request<{ id: string }>('screen:produce', { transportId: t.id, kind, rtpParameters }).then(ok, fail);
    });
    const { codec, hardware } = await pickCodec(device);
    const mode = share.motion ? MODES.motion : MODES.detail;
    share.producer = await t.produce({
      track: share.stream.getVideoTracks()[0],
      codec,
      encodings: [{ maxBitrate: mode.maxBitrate }],
      codecOptions: { videoGoogleStartBitrate: 1000 },
      stopTracks: false,
    });
    if (gen !== publishGen) return;
    const name = codec?.mimeType.replace(/^video\//i, '') ?? '';
    useStore.setState((s) => ({ myShare: s.myShare && { ...s.myShare, codec: name, hardware } }));
  } catch (err) {
    if (gen !== publishGen) return;
    toast(`화면 공유를 시작하지 못했어요. ${(err as Error).message}`, 5000);
    stopSharing();
  }
}

/**
 * The encoder runs on the teacher's PC, so prefer one the graphics chip runs (H.264 or VP9 on
 * most office PCs). Software encoding falls back to VP8, the cheapest for the CPU.
 */
async function pickCodec(device: Device): Promise<{ codec?: types.RtpCodecCapability; hardware: boolean }> {
  const codecs = device.rtpCapabilities.codecs ?? [];
  const find = (mime: string) => codecs.find((c) => c.mimeType.toLowerCase() === mime);
  for (const mime of ['video/h264', 'video/vp9']) {
    const codec = find(mime);
    if (codec && (await isHardwareEncoded(codec.mimeType))) return { codec, hardware: true };
  }
  return { codec: find('video/vp8'), hardware: false };
}

async function isHardwareEncoded(contentType: string): Promise<boolean> {
  try {
    const info = await navigator.mediaCapabilities.encodingInfo({
      type: 'webrtc',
      video: { contentType, width: 1920, height: 1080, bitrate: MODES.detail.maxBitrate, framerate: 15 },
    });
    return info.supported && info.powerEfficient;
  } catch {
    return false; // this browser can't tell
  }
}

/** Switches between sharp text (15 fps) and smooth video (30 fps) without restarting. */
export async function setShareMotion(motion: boolean) {
  const share = sending;
  if (!share) return;
  share.motion = motion;
  const mode = motion ? MODES.motion : MODES.detail;
  const track = share.stream.getVideoTracks()[0];
  track.contentHint = motion ? 'motion' : 'detail';
  useStore.setState((s) => ({ myShare: s.myShare && { ...s.myShare, motion } }));
  await Promise.all([
    track.applyConstraints({ frameRate: { ideal: mode.frameRate, max: 30 }, width: { max: 1920 }, height: { max: 1080 } }),
    share.producer?.setRtpEncodingParameters({ maxBitrate: mode.maxBitrate }),
  ]).catch(() => {});
}

export function stopSharing() {
  const share = sending;
  if (!share) return;
  sending = null;
  publishGen++;
  share.transport?.close();
  for (const track of share.stream.getTracks()) track.stop();
  useStore.setState({ myShare: null });
  if (socket.connected) request('screen:stop', {}).catch(() => {});
}

// ---- student ----

interface Watching {
  nodeId?: string;
  transport?: types.Transport;
  consumer?: types.Consumer;
  timers: ReturnType<typeof setTimeout>[];
}
let watching: Watching | null = null;
/** PCs this browser couldn't get a picture through during this share. */
const failedNodes = new Set<string>();

function wantScreen() {
  const s = useStore.getState();
  return s.connected && s.me?.role === 'student' && s.screen.live && s.screenView;
}

/** Starts or stops receiving to match what the student should see. */
function syncWatching() {
  if (wantScreen()) {
    if (!watching) void watch();
  } else if (watching) {
    stopWatching(true);
  }
}

async function watch() {
  const w: Watching = { timers: [] };
  watching = w;
  useStore.setState({ screenTrack: null, screenVia: null, screenStatus: '강사 화면에 연결하는 중…' });
  try {
    const res = await request<JoinReply>('screen:join', { exclude: [...failedNodes] });
    if (watching !== w) return;
    w.nodeId = res.nodeId;
    const device = new Device();
    await device.load({ routerRtpCapabilities: res.routerRtpCapabilities });
    const t = device.createRecvTransport(res.transport);
    w.transport = t;
    t.on('connect', ({ dtlsParameters }, ok, fail) => {
      request('screen:connect', { transportId: t.id, dtlsParameters }).then(ok, fail);
    });
    t.on('connectionstatechange', (state) => {
      if (watching !== w) return;
      // A PC that stops answering (switched off, cable pulled) is left after a few seconds.
      if (state === 'failed') tryAnotherPc(w);
      else if (state === 'disconnected') w.timers.push(setTimeout(() => t.connectionState !== 'connected' && tryAnotherPc(w), 5000));
    });
    const info = await request<ConsumeReply>('screen:consume', { transportId: t.id, rtpCapabilities: device.rtpCapabilities });
    if (watching !== w) return;
    w.consumer = await t.consume(info);
    await request('screen:resume', { consumerId: w.consumer.id });
    if (watching !== w) return;
    useStore.setState({ screenTrack: w.consumer.track, screenVia: res.nodeName, screenStatus: '화면을 받는 중…' });
    void waitForPicture(w);
  } catch (err) {
    if (watching !== w) return;
    useStore.setState({ screenStatus: `강사 화면에 연결하지 못했어요. 다시 시도하는 중… (${(err as Error).message})` });
    w.timers.push(setTimeout(() => restartWatching(w), 3000));
  }
}

/**
 * Some networks pass the signaling but block the video (a firewall on a relay PC, UDP and TCP
 * both closed). Without a decoded frame in 10 seconds, ask for a different PC.
 */
async function waitForPicture(w: Watching) {
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (watching !== w || !w.consumer) return;
    const stats = await w.consumer.getStats().catch(() => null);
    let frames = 0;
    stats?.forEach((s) => {
      if (s.type === 'inbound-rtp') frames += s.framesDecoded ?? 0;
    });
    if (frames > 0) {
      if (watching === w) useStore.setState({ screenStatus: null });
      return;
    }
  }
  if (watching === w) tryAnotherPc(w);
}

function tryAnotherPc(w: Watching) {
  if (watching !== w) return;
  if (w.nodeId) failedNodes.add(w.nodeId);
  restartWatching(w);
}

function restartWatching(w: Watching) {
  if (watching !== w) return;
  stopWatching(false);
  syncWatching();
}

/** `tell`: let the server know (it already does when it moved us or the share ended). */
function stopWatching(tell: boolean) {
  const w = watching;
  if (!w) return;
  watching = null;
  for (const t of w.timers) clearTimeout(t);
  w.transport?.close();
  useStore.setState({ screenTrack: null, screenVia: null, screenStatus: null });
  if (tell && socket.connected) request('screen:leave', {}).catch(() => {});
}

// The relay PC this student watched through went away: the server wants us on another PC.
socket.on('screen:moved', () => {
  stopWatching(false);
  syncWatching();
});

useStore.subscribe((s, prev) => {
  if (s.screen.live && !prev.screen.live) failedNodes.clear();
  if (s.connected !== prev.connected || s.screen.live !== prev.screen.live || s.screenView !== prev.screenView || s.me !== prev.me) {
    // Disconnected: the server already dropped this viewer.
    if (!s.connected) stopWatching(false);
    syncWatching();
  }
  // The server ends a share when the teacher's connection drops; send it again on reconnect.
  if (s.connected && !prev.connected && sending) void publish();
});
