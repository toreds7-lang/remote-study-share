import type { Response } from 'express';
import { config } from './config.ts';

interface AskInput {
  question: string;
  pageText: string;
  history: { role: 'user' | 'assistant'; text: string }[];
  docName: string | null;
  page: number | null;
  courseTitle: string;
}

const SYSTEM_PROMPT = `너는 온라인 강의의 학습 도우미(조교)야.
학생이 지금 보고 있는 교안 페이지의 텍스트가 함께 주어진다. 그 내용을 우선 근거로 삼아 한국어로 간결하고 정확하게 답해.
- 교안에 없는 내용은 일반 지식으로 보충하되, 교안 내용과 구분해서 말해.
- 모르면 모른다고 하고, 강사에게 질문하도록 권해.
- 답은 짧은 문단이나 글머리표로 정리해.`;

/** Streams the model's answer to `res` as plain UTF-8 text. */
export async function askAi(res: Response, input: AskInput) {
  const context = [
    `과목: ${input.courseTitle}`,
    input.docName ? `교안: ${input.docName}${input.page ? ` (p.${input.page})` : ''}` : null,
    `--- 현재 페이지 텍스트 ---\n${input.pageText.trim() || '(텍스트 없음: 이미지로만 된 페이지일 수 있음)'}`,
  ]
    .filter(Boolean)
    .join('\n');

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'system', content: context },
    ...input.history.map((m) => ({ role: m.role, content: m.text })),
    { role: 'user', content: input.question },
  ];

  const abort = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) abort.abort();
  });

  let upstream: globalThis.Response;
  try {
    upstream = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.openaiKey}` },
      body: JSON.stringify({ model: config.llmModel, messages, stream: true, max_tokens: 1200 }),
      signal: abort.signal,
    });
  } catch (err) {
    if (!abort.signal.aborted) console.error('[ai] request failed', err);
    if (!res.headersSent) res.status(502).json({ error: 'AI 서버에 연결하지 못했어요.' });
    return;
  }

  if (!upstream.ok || !upstream.body) {
    console.error('[ai] upstream error', upstream.status, await upstream.text().catch(() => ''));
    res.status(502).json({ error: `AI 응답 오류 (${upstream.status})` });
    return;
  }

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');

  // Parse the server-sent events stream and forward only the text deltas.
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for await (const chunk of upstream.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const delta = JSON.parse(data).choices?.[0]?.delta?.content;
          if (delta) res.write(delta);
        } catch {
          // Ignore keep-alive or malformed lines.
        }
      }
    }
  } catch (err) {
    if (!abort.signal.aborted) console.error('[ai] stream error', err);
  }
  res.end();
}
