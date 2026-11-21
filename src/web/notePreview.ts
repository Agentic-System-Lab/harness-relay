/** Preserve all lines, including their endings. Show unchanged context once and both versions of the changed block. */
export function changeBlocks(before: string, after: string) {
  const lines = (s: string) => s.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [];
  const a = lines(before),
    b = lines(after);
  let start = 0,
    tail = 0;
  while (start < Math.min(a.length, b.length) && a[start] === b[start]) start++;
  while (tail < Math.min(a.length, b.length) - start && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  return {
    context: a.slice(0, start).join(''),
    removed: a.slice(start, a.length - tail).join(''),
    added: b.slice(start, b.length - tail).join(''),
    end: a.slice(a.length - tail).join(''),
  };
}

export function noteFormat(value: string) {
  const endings = new Set(value.match(/\r\n|\r|\n/g));
  const lineEnding = endings.size > 1 ? 'mixed' : endings.has('\r\n') ? 'CRLF' : endings.has('\r') ? 'CR' : endings.has('\n') ? 'LF' : '';
  return { bom: value.startsWith('\uFEFF'), lineEnding, finalNewline: /[\n\r]$/.test(value) };
}
