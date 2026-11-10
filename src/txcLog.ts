const LEVEL_LABELS: { [level: string]: string } = {
  Trace: 'TRACE',
  Debug: 'DEBUG',
  Information: 'INFO',
  Warning: 'WARN',
  Error: 'ERROR',
  Critical: 'CRIT'
};

// Streams txc output into the channel in the short form; when the command fails,
// re-prints in full every entry whose short form hid something.
export function createTxcOutputWriter(appendLine: (line: string) => void): {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  finish: (failed: boolean) => void;
} {
  const details: string[][] = [];
  const writeLine = (line: string) => {
    for (const shown of formatTxcLogLine(line)) appendLine(shown);
    const detailed = formatTxcLogLineDetailed(line);
    if (detailed) details.push(detailed);
  };
  const outLines = createLineBuffer(writeLine);
  const errLines = createLineBuffer(writeLine);
  return {
    stdout: (text: string) => outLines.push(text),
    stderr: (text: string) => errLines.push(text),
    finish: (failed: boolean) => {
      outLines.flush();
      errLines.flush();
      if (!failed || details.length === 0) return;
      appendLine('--- Full txc error details ---');
      for (const line of details.flat()) appendLine(line);
    }
  };
}

// txc switches to JSON log lines whenever its stdout is piped (always the case
// under the extension) and TXC_LOG_FORMAT can't turn that off, so render them here.
export function formatTxcLogLine(line: string): string[] {
  if (line.trim().length === 0) return [];
  const entry = parseTxcLogEntry(line);
  if (!entry) return [line];

  const lines = humanizeEmbeddedJson(splitExceptionDump(entry.msg).message)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return withLevelLabel(entry.level, lines);
}

// Full form of an entry: the stack trace plus embedded JSON laid out as a tree;
// undefined when the short form already shows everything.
export function formatTxcLogLineDetailed(line: string): string[] | undefined {
  const entry = parseTxcLogEntry(line);
  if (!entry) return undefined;
  const { message, exception } = splitExceptionDump(entry.msg);
  if (!exception && humanizeEmbeddedJson(message) === message) return undefined;

  const exceptionLines = exception
    .split(/\r?\n/)
    .map((l) => humanizeEmbeddedJson(l).trimEnd())
    .filter((l) => l.trim().length > 0);
  return withLevelLabel(entry.level, [...expandEmbeddedJson(message), ...exceptionLines]);
}

function withLevelLabel(level: string, lines: string[]): string[] {
  const label = `[${LEVEL_LABELS[level] ?? level.toUpperCase()}]`;
  if (lines.length === 0) return [label];
  const indent = ' '.repeat(label.length + 1);
  return [`${label} ${lines[0]}`, ...lines.slice(1).map((l) => indent + l)];
}

function parseTxcLogEntry(line: string): { level: string; msg: string } | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return undefined;
  let parsed: any;
  try { parsed = JSON.parse(trimmed); } catch { return undefined; }
  const isLogLine = parsed && typeof parsed.ts === 'string' && typeof parsed.level === 'string' && typeof parsed.msg === 'string';
  return isLogLine ? { level: parsed.level, msg: parsed.msg } : undefined;
}

// The JSON sink appends Exception.ToString() to the message.
function splitExceptionDump(msg: string): { message: string; exception: string } {
  const index = msg.search(/\s[\w.]+Exception: [\s\S]*\n\s+at /);
  if (index === -1) return { message: msg, exception: '' };
  return { message: msg.slice(0, index), exception: msg.slice(index).trim() };
}

function expandEmbeddedJson(text: string): string[] {
  const lines: string[] = [];
  const pushText = (segment: string) => {
    for (const l of segment.split(/\r?\n/)) {
      if (l.trim().length > 0) lines.push(l.trim());
    }
  };
  let pending = '';
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf('{', i);
    if (start === -1) break;
    const end = findJsonObjectEnd(text, start);
    const parsed = end === -1 ? undefined : parseJsonContainer(text.slice(start, end + 1));
    if (!parsed) {
      pending += text.slice(i, start + 1);
      i = start + 1;
      continue;
    }
    pushText(pending + text.slice(i, start));
    pending = '';
    lines.push(...jsonTreeLines(parsed, '  '));
    i = end + 1;
  }
  pushText(pending + text.slice(i));
  return lines;
}

// String fields that hold a whole JSON document are expanded too, so the tree
// never shows escaped quotes.
function jsonTreeLines(value: object, indent: string): string[] {
  const entries: [string, unknown][] = Array.isArray(value)
    ? value.map((v, i): [string, unknown] => [`[${i}]`, v])
    : Object.entries(value);
  const lines: string[] = [];
  for (const [key, raw] of entries) {
    const child = typeof raw === 'string' ? parseJsonContainer(raw) ?? raw : raw;
    if (child !== null && typeof child === 'object' && Object.keys(child).length > 0) {
      lines.push(`${indent}${key}:`, ...jsonTreeLines(child, indent + '  '));
    } else {
      lines.push(`${indent}${key}: ${formatScalar(child)}`);
    }
  }
  return lines;
}

function formatScalar(value: unknown): string {
  if (typeof value !== 'string') return JSON.stringify(value);
  return value.length === 0 ? '""' : value.replace(/\r?\n/g, ' ');
}

function parseJsonContainer(text: string): object | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(trimmed); } catch { return undefined; }
  return parsed !== null && typeof parsed === 'object' ? parsed : undefined;
}

// Dataverse errors arrive as JSON inside the message, sometimes nested inside
// string fields, so keep only code + message from every embedded object.
export function humanizeEmbeddedJson(text: string): string {
  let result = '';
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf('{', i);
    if (start === -1) break;
    const end = findJsonObjectEnd(text, start);
    const summary = end === -1 ? undefined : summarizeJsonError(text.slice(start, end + 1));
    if (summary === undefined) {
      result += text.slice(i, start + 1);
      i = start + 1;
      continue;
    }
    result += text.slice(i, start) + summary;
    i = end + 1;
  }
  return result + text.slice(i);
}

function findJsonObjectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') {
        i++;
      } else if (ch === '"') {
        inString = false;
      }
    } else if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function summarizeJsonError(json: string): string | undefined {
  let parsed: any;
  try { parsed = JSON.parse(json); } catch { return undefined; }
  const error = parsed && typeof parsed.error === 'object' && parsed.error ? parsed.error : parsed;
  const message = error?.message ?? error?.Message;
  if (typeof message !== 'string' || message.length === 0) return undefined;
  const code = error.code ?? error.Code;
  const text = humanizeEmbeddedJson(message);
  return typeof code === 'string' && code.length > 0 ? `${code}: ${text}` : text;
}

// Process output arrives in arbitrary chunks, so a JSON log line can be split
// across two of them; only complete lines are handed on.
export function createLineBuffer(onLine: (line: string) => void): { push: (text: string) => void; flush: () => void } {
  let pending = '';
  return {
    push: (text: string) => {
      pending += text;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) onLine(line);
    },
    flush: () => {
      if (pending.length > 0) onLine(pending);
      pending = '';
    }
  };
}
