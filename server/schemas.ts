import { z } from 'zod';
import { LIMITS } from '../shared/protocol.ts';

const id = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const coord = z.number().finite().min(-0.5).max(1.5);
/** y on a live HTML 교안 is measured down the scrolled document, so it can be many frame heights. */
const coordY = z.number().finite().min(-0.5).max(1000);
const page = z.number().int().min(1).max(100000);

const strokeBase = {
  id,
  docId: id,
  page,
  color,
  size: z.number().finite().min(0.5).max(100),
};

export const strokeSchema = z.discriminatedUnion('kind', [
  z.object({
    ...strokeBase,
    kind: z.literal('pen'),
    points: z
      .array(coordY)
      .min(2)
      .max(LIMITS.strokePoints)
      .refine((p) => p.length % 2 === 0),
  }),
  z.object({
    ...strokeBase,
    kind: z.literal('text'),
    x: coord,
    y: coordY,
    text: z.string().trim().min(1).max(LIMITS.textStrokeLen),
  }),
]);

export const liveInkSchema = z.object({
  id,
  docId: id,
  page,
  color,
  size: z.number().finite().min(0.5).max(100),
  points: z
    .array(coordY)
    .max(2000)
    .refine((p) => p.length % 2 === 0),
});

const scroll = z.number().finite().min(0).max(1e7);
export const navSchema = z.object({
  docId: id,
  page,
  html: z.object({ hash: z.string().max(500), x: scroll, y: scroll }).optional(),
});
export const docRefSchema = z.object({ docId: id });
export const pageRefSchema = z.object({ docId: id, page });
export const strokeIdsSchema = z.object({ ids: z.array(id).min(1).max(5000) });
export const laserSchema = z.object({ docId: id, page, x: coord, y: coordY }).nullable();

const name = z.string().trim().min(1).max(LIMITS.nameLen);
const pin = z.string().min(4).max(64);
const roomCode = z.string().trim().regex(/^[A-Za-z0-9]{4,12}$/);

export const createRoomSchema = z.object({
  title: z.string().trim().min(1).max(LIMITS.titleLen),
  code: roomCode.optional().or(z.literal('')),
  teacherName: name,
  teacherPin: pin,
  adminPassword: z.string().max(200).optional(),
});

export const joinSchema = z.object({
  code: roomCode,
  name,
  role: z.enum(['teacher', 'student']),
  pin: z.string().max(64).optional(),
});

export const questionSchema = z.object({
  body: z.string().trim().min(1).max(LIMITS.questionLen),
  anonymous: z.boolean(),
  docId: id.nullable(),
  page: page.nullable(),
});
export const questionIdSchema = z.object({ id: z.number().int().positive() });
export const answerSchema = z.object({
  id: z.number().int().positive(),
  answer: z.string().trim().max(LIMITS.questionLen),
});
export const resolveSchema = z.object({ id: z.number().int().positive(), resolved: z.boolean() });

export const chatSchema = z.object({ body: z.string().trim().min(1).max(LIMITS.chatLen) });
export const handSchema = z.object({ raised: z.boolean() });
export const lowerHandSchema = z.object({ userId: z.number().int().positive().nullable() });

/** Optional file category, typed with or without a leading '#'. Empty means none. */
const fileTag = z
  .string()
  .trim()
  .max(LIMITS.tagLen + 5)
  .transform((t) => t.replace(/^#+/, '').trim().slice(0, LIMITS.tagLen) || null);

/** Multipart form fields sent with an upload (all strings). */
export const fileUploadSchema = z.object({
  tag: fileTag.optional(),
  hidden: z.enum(['0', '1']).optional(),
  asDoc: z.enum(['0', '1']).optional(),
});

export const fileUpdateSchema = z.object({
  name: z.string().trim().min(1).max(LIMITS.fileNameLen).optional(),
  tag: fileTag.nullable().optional(),
  hidden: z.boolean().optional(),
});

export const zipQuerySchema = z.object({
  ids: z
    .string()
    .max(LIMITS.zipFiles * 65)
    .transform((s) => s.split(','))
    .pipe(z.array(id).min(1).max(LIMITS.zipFiles)),
});

export const aiAskSchema = z.object({
  question: z.string().trim().min(1).max(LIMITS.aiQuestionLen),
  docId: id.nullable(),
  page: page.nullable(),
  pageText: z.string().max(LIMITS.aiContextLen),
  history: z
    .array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().max(4000) }))
    .max(10),
});

const paper = z.enum(['blank', 'grid', 'lines']);

export const blankDocSchema = z.object({
  name: z.string().trim().min(1).max(LIMITS.fileNameLen - 4),
  pages: z.number().int().min(1).max(LIMITS.whiteboardPages),
  paper,
});

/** Multipart fields for inserting a page; the new page becomes page `at`. */
export const insertPageSchema = z.object({
  at: z.coerce.number().int().min(1).max(100000),
  paper: paper.default('blank'),
});

// ---- 화면 공유 ----
// mediasoup checks the WebRTC parameters themselves; these only bound their shape.

const mediaId = z.string().min(1).max(64);
const mediaParams = z.record(z.string(), z.unknown());

export const noArgsSchema = z.object({}).optional();
export const screenConnectSchema = z.object({ transportId: mediaId, dtlsParameters: mediaParams });
export const screenProduceSchema = z.object({ transportId: mediaId, kind: z.literal('video'), rtpParameters: mediaParams });
/** `exclude`: PCs this browser couldn't get the screen through, so it is sent to another one. */
export const screenJoinSchema = z.object({ exclude: z.array(z.string().max(100)).max(50).default([]) });
export const screenConsumeSchema = z.object({ transportId: mediaId, rtpCapabilities: mediaParams });
export const screenResumeSchema = z.object({ consumerId: mediaId });

/** What a relay PC sends when it connects (socket.handshake.auth). */
export const relayAuthSchema = z.object({
  key: z.string().max(200),
  name: z.string().trim().min(1).max(40),
  seats: z.number().int().min(1).max(1000),
});
