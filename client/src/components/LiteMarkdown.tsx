import type { ReactNode } from 'react';

/** Renders **bold** and `code` spans as React elements (never raw HTML). */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return <code key={i}>{part.slice(1, -1)}</code>;
    return part;
  });
}

/** Minimal markdown for chat-style AI answers: headings, bullets, bold, inline code. */
export function LiteMarkdown({ text }: { text: string }) {
  return (
    <div className="md">
      {text.split('\n').map((line, i) => {
        const heading = /^#{1,6}\s+(.*)$/.exec(line);
        if (heading) return <div key={i} className="md-h">{inline(heading[1])}</div>;
        const bullet = /^(\s*)[-*•]\s+(.*)$/.exec(line);
        if (bullet) {
          const depth = Math.min(3, Math.floor(bullet[1].length / 2));
          return (
            <div key={i} className="md-li" style={{ paddingLeft: 14 + depth * 14 }}>
              {inline(bullet[2])}
            </div>
          );
        }
        if (!line.trim()) return <div key={i} className="md-gap" />;
        return <div key={i}>{inline(line)}</div>;
      })}
    </div>
  );
}
