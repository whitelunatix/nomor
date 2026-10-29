import { buildWordDocument } from './document';
import type { WordDocument, WordWorkerResult } from './protocol';

self.onmessage = async (event: MessageEvent<WordDocument>) => {
  try {
    const bytes = await buildWordDocument(event.data);
    self.postMessage({ bytes } satisfies WordWorkerResult, { transfer: [bytes] });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) } satisfies WordWorkerResult);
  }
};
