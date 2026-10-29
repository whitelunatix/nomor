/** Shared DOM primitives; editing/commit ownership stays with the caller. */
export function createInlineMathInput(doc: Document, value: string): HTMLInputElement {
  const input = doc.createElement('input');
  input.type = 'text';
  input.className = 'math-inline-input';
  input.contentEditable = 'true';
  input.value = value;
  return input;
}

export function createInlineMathPreview(doc: Document): {
  card: HTMLDivElement;
  content: HTMLDivElement;
} {
  const card = doc.createElement('div');
  card.className = 'math-inline-preview';
  card.style.position = 'fixed';
  card.style.zIndex = '1000';
  const content = doc.createElement('div');
  content.className = 'math-inline-preview-content';
  card.append(content);
  return { card, content };
}
