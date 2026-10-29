/** 只传递可序列化的正文和媒体；不能把编辑器、DOM 或回调交给 Worker。 */
export interface WordNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  content?: WordNode[];
}

export interface WordMedia {
  id: string;
  bytes: Uint8Array;
  type: 'png' | 'jpg';
  width: number;
  height: number;
}

export interface WordDocument {
  title: string;
  nodes: WordNode[];
  headings: Array<{ id: string; title: string; level: number }>;
  media: WordMedia[];
  labels: { comment: string };
}

export type WordWorkerResult = { bytes: ArrayBuffer } | { error: string };
export const WORD_CONTENT_WIDTH_PX = (170 / 25.4) * 96;
export const WORD_CONTENT_HEIGHT_PX = (257 / 25.4) * 96;
export const WORD_MEDIA_BUDGET = 128 * 1024 * 1024;
export const WORD_CANVAS_PIXELS = 16_000_000;

export class WordBudgetError extends Error {}

export function assertWordCanvasSize(width: number, height: number, scale = 1) {
  if (!Number.isFinite(width * height) || width <= 0 || height <= 0 ||
      Math.ceil(width * scale) * Math.ceil(height * scale) > WORD_CANVAS_PIXELS) {
    throw new WordBudgetError('canvas');
  }
}
