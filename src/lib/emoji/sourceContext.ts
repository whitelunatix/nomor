import type { Text, ChangeDesc } from '@codemirror/state';

interface Marker {
  pos: number;
  end: number;
  char: string;
  count: number;
  closing: boolean;
}

/** 仅保存围栏定长元数据，最多4096条（粗估小于0.5MiB）；普通编辑只重查受影响行，不缓存正文或全文 token。 */
export class SourceEmojiContext {
  private markers: Marker[] = [];
  private initialized = false;
  private overflow = false;

  private scan(doc: Text, from: number, to: number): Marker[] {
    const markers: Marker[] = [];
    let line = doc.lineAt(from).number;
    const last = doc.lineAt(to).number;
    for (; line <= last; line++) {
      const current = doc.line(line);
      const text = current.text.replace(/^\s*(?:>\s*)*(?:(?:[-+*]|\d+[.)])\s+)?/, '');
      const fence = /^(`{3,}|~{3,})/.exec(text);
      if (fence)
        markers.push({
          pos: current.from,
          end: current.to,
          char: fence[1][0],
          count: fence[1].length,
          closing: !text.slice(fence[1].length).trim(),
        });
      else if (/^\$\$\s*$/.test(text))
        markers.push({ pos: current.from, end: current.to, char: '$', count: 2, closing: true });
      if (markers.length > 4096) {
        this.overflow = true;
        return [];
      }
    }
    return markers;
  }

  update(before: Text, after: Text, changes: ChangeDesc): void {
    if (!this.initialized) return;
    if (this.overflow) {
      if (after.lines <= 4096) {
        this.markers = [];
        this.initialized = false;
        this.overflow = false;
      }
      return;
    }
    const ranges: Array<{ a: number; b: number; from: number; to: number }> = [];
    changes.iterChangedRanges((fromA, toA, fromB, toB) => {
      ranges.push({
        a: before.lineAt(fromA).from,
        b: before.lineAt(toA).to,
        from: after.lineAt(fromB).from,
        to: after.lineAt(toB).to,
      });
    });
    this.markers = this.markers
      .filter((marker) => !ranges.some(({ a, b }) => marker.pos >= a && marker.pos <= b))
      .map((marker) => ({
        ...marker,
        pos: changes.mapPos(marker.pos, 1),
        end: changes.mapPos(marker.end, -1),
      }));
    for (const range of ranges) this.markers.push(...this.scan(after, range.from, range.to));
    this.markers = [...new Map(this.markers.map((marker) => [marker.pos, marker])).values()].sort(
      (a, b) => a.pos - b.pos,
    );
    if (this.markers.length > 4096) {
      this.markers = [];
      this.overflow = true;
    }
  }

  allows(doc: Text, position: number): boolean {
    if (!this.initialized) {
      this.initialized = true;
      this.markers = this.scan(doc, 0, doc.length);
    }
    if (this.overflow) return false;
    let fence: { char: string; count: number } | null = null;
    let math = false;
    let inlineStart = 0;
    for (const marker of this.markers) {
      if (marker.pos > position) break;
      const insideBlock = !!fence || math;
      if (marker.char !== '$' && !math) {
        if (!fence) fence = { char: marker.char, count: marker.count };
        else if (marker.char === fence.char && marker.count >= fence.count && marker.closing)
          fence = null;
      } else if (!fence && marker.char === '$') math = !math;
      if (insideBlock && !fence && !math) inlineStart = marker.end;
    }
    if (fence || math) return false;
    // 行内代码可跨软换行；只检查当前段落的有界前缀，超预算时保守禁用建议。
    const tailStart = Math.max(inlineStart, position - 4097);
    const tail = doc.sliceString(tailStart, position);
    let paragraphStart = 0;
    for (const boundary of tail.matchAll(/\n[ \t]*\n/g))
      paragraphStart = boundary.index! + boundary[0].length;
    if (tailStart > inlineStart && !paragraphStart) return false;
    const before = tail.slice(paragraphStart);
    const currentLine = before.slice(before.lastIndexOf('\n') + 1);
    if (/^(?: {4}|\t)/.test(currentLine) || /\]\([^)]*$|<[^>]*$/.test(before)) return false;
    let code = 0;
    let inlineMath = false;
    const markers = /\\.|`+|\$/g;
    for (const match of before.matchAll(markers)) {
      if (match[0].startsWith('\\')) continue;
      if (match[0][0] === '`') {
        if (!code) code = match[0].length;
        else if (code === match[0].length) code = 0;
      } else if (!code) inlineMath = !inlineMath;
    }
    return !code && !inlineMath;
  }
}
