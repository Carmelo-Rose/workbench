import type { MonoSubjectSnapshot } from "./contracts";

const SUBJECT_DIRECTIVE_RE = /:subject\[([^\]\n]{1,1024})\](?:\{name=([^}\n]{1,1024})\})?/gu;
const REF_TOKEN = "参考图\\d+(?:（[^）]+）)?";

export function subjectIdsFromPrompt(prompt: string): string[] {
  const ids: string[] = [];
  for (const match of prompt.matchAll(SUBJECT_DIRECTIVE_RE)) {
    const id = match[2] ?? match[1];
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

function cleanObjectPhrase(value: string): string {
  return value.trim().replace(/^(?:将|把|用|拿)\s*/u, "").trim();
}

function formatReference(index: number, name: string): string {
  return `参考图${index}（${name}）`;
}

function expandActionTemplate(text: string): string {
  const templates: Array<[RegExp, (...parts: string[]) => string]> = [
    [new RegExp(`(${REF_TOKEN})\\s*换上\\s*(.+)`, "gu"), (_match, subject, object) =>
      `以 ${subject} 为主体，将 ${cleanObjectPhrase(object)} 中的核心物品/服饰/配件应用到 ${subject} 上`],
    [new RegExp(`(?:将|把|用)?\\s*(.+?)\\s*(?:戴[到在]|佩戴[到在])\\s*(${REF_TOKEN})\\s*(?:上|身上|头上|脸上|眼部|对应位置)?`, "gu"), (_match, object, subject) =>
      `保留 ${subject} 的人物主体，将 ${cleanObjectPhrase(object)} 中的配件佩戴到 ${subject} 的对应位置`],
    [new RegExp(`给\\s*(${REF_TOKEN})\\s*(?:戴上|佩戴)\\s*(.+)`, "gu"), (_match, subject, object) =>
      `保留 ${subject} 的人物主体，将 ${cleanObjectPhrase(object)} 中的配件佩戴到 ${subject} 的对应位置`],
    [new RegExp(`(${REF_TOKEN})\\s*(?:戴上|佩戴)\\s*(.+)`, "gu"), (_match, subject, object) =>
      `保留 ${subject} 的人物主体，将 ${cleanObjectPhrase(object)} 中的配件佩戴到 ${subject} 的对应位置`],
    [new RegExp(`(${REF_TOKEN})\\s*变成\\s*(.+)风格`, "gu"), (_match, subject, style) =>
      `保留 ${subject} 的主体结构，迁移 ${cleanObjectPhrase(style)} 的视觉风格`],
    [new RegExp(`(${REF_TOKEN})\\s*(?:换[成为]?|替换[成为]?)\\s*(.+)背景`, "gu"), (_match, subject, background) =>
      `以 ${subject} 为前景主体，替换为 ${cleanObjectPhrase(background)} 的背景`],
  ];
  for (const [pattern, rewrite] of templates) {
    const next = text.replace(pattern, (...args) => rewrite(...args.slice(0, -2) as string[]));
    if (next !== text) return next;
  }
  return text;
}

export function compileSubjectPrompt(
  rawPrompt: string,
  references: string[],
  subjects: MonoSubjectSnapshot[],
): string {
  const byId = new Map(subjects.map((subject) => [subject.id, subject]));
  let rewritten = rawPrompt.replace(SUBJECT_DIRECTIVE_RE, (_match, label: string, explicitId?: string) => {
    const subject = byId.get(explicitId ?? label);
    if (!subject) return `@${label}`;
    const index = references.indexOf(subject.sourceUrl);
    return index >= 0 ? formatReference(index + 1, subject.name) : `@${subject.name}`;
  });

  // MCP callers may send readable @name text together with ordered subjectIds.
  for (const subject of [...subjects].sort((a, b) => b.name.length - a.name.length)) {
    const index = references.indexOf(subject.sourceUrl);
    if (index >= 0) rewritten = rewritten.split(`@${subject.name}`).join(formatReference(index + 1, subject.name));
  }
  rewritten = expandActionTemplate(rewritten.replace(/\s{2,}/gu, " ").trim());
  if (!references.length) return rewritten;
  return `你将收到 ${references.length} 张参考图，编号与输入图片顺序一致。\n请严格按编号理解用户指令。\n\n用户指令：${rewritten}`;
}
