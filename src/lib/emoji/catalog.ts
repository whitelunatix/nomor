export interface CompactEmoji {
  hexcode: string;
  unicode: string;
  label: string;
  group?: number;
  order?: number;
  tags?: string[];
  skins?: CompactEmoji[];
}

export interface EmojiCatalogPayload {
  version: string;
  en: CompactEmoji[];
  zh: CompactEmoji[];
  shortcodes: Record<string, string | string[]>;
}

export interface EmojiEntry {
  id: string;
  unicode: string;
  en: string;
  zh: string;
  group: number;
  order: number;
  shortcodes: string[];
  terms: string[];
}

export const EMOJI_GROUPS = [0, 1, 3, 4, 6, 5, 7, 8, 9] as const;

export function normalizeEmojiQuery(text: string): string {
  return text.normalize('NFKC').trim().replace(/^:|:$/g, '').toLowerCase();
}

/** 只构建一份有界元数据索引；不持有正文、编辑器或组件回调。 */
export function buildEmojiCatalog(payload: EmojiCatalogPayload): readonly EmojiEntry[] {
  const flatten = (entries: CompactEmoji[]): CompactEmoji[] =>
    entries.flatMap((entry) => [entry, ...(entry.skins ?? [])]);
  const chinese = new Map(flatten(payload.zh).map((entry) => [entry.hexcode, entry]));
  return flatten(payload.en)
    .filter((entry) => EMOJI_GROUPS.includes(entry.group as (typeof EMOJI_GROUPS)[number]))
    .map((entry) => {
      const zh = chinese.get(entry.hexcode);
      const aliases = payload.shortcodes[entry.hexcode];
      const shortcodes = typeof aliases === 'string' ? [aliases] : [...(aliases ?? [])];
      const name = entry.label
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '_')
        .replace(/^_|_$/g, '');
      if (name && !shortcodes.includes(name)) shortcodes.push(name);
      return {
        id: entry.hexcode,
        unicode: entry.unicode,
        en: entry.label,
        zh: zh?.label ?? entry.label,
        group: entry.group!,
        order: entry.order ?? Number.MAX_SAFE_INTEGER,
        shortcodes,
        terms: [
          ...new Set(
            [
              ...shortcodes,
              entry.label,
              zh?.label ?? '',
              ...(entry.tags ?? []),
              ...(zh?.tags ?? []),
            ]
              .filter(Boolean)
              .map(normalizeEmojiQuery),
          ),
        ],
      };
    })
    .sort((a, b) => a.order - b.order);
}

export function searchEmoji(
  catalog: readonly EmojiEntry[],
  text: string,
  group?: number,
  limit = Infinity,
): EmojiEntry[] {
  const query = normalizeEmojiQuery(text);
  const words = query.split(/\s+/);
  const matches: Array<{ entry: EmojiEntry; score: number }> = [];
  for (const entry of catalog) {
    if (group !== undefined && entry.group !== group) continue;
    if (!query) {
      matches.push({ entry, score: 0 });
      continue;
    }
    if (
      !words.every(
        (word) => entry.terms.some((term) => term.includes(word)) || entry.unicode === word,
      )
    )
      continue;
    const score =
      entry.shortcodes.includes(query) || entry.unicode === query
        ? 0
        : entry.terms.includes(query)
          ? 1
          : entry.shortcodes.some((term) => term.startsWith(query))
            ? 2
            : entry.terms.some((term) => term.startsWith(query))
              ? 3
              : 4;
    matches.push({ entry, score });
  }
  return matches
    .sort((a, b) => a.score - b.score || a.entry.order - b.entry.order)
    .slice(0, limit)
    .map(({ entry }) => entry);
}

export interface EmojiQuery {
  from: number;
  to: number;
  text: string;
}

/** 只读取光标前的短尾部，排除时间、协议和盘符中的冒号。 */
export function findEmojiQuery(before: string, end: number): EmojiQuery | null {
  const match = /(^|[\s\p{P}])(:([\p{L}\p{N}_+\-]{1,64}):?)$/u.exec(before);
  if (!match || /[\\/:`_$]/.test(match[1])) return null;
  return { from: end - match[2].length, to: end, text: match[3] };
}
