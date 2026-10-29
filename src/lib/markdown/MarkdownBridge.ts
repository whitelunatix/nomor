import { extractFrontMatterBlock } from './frontMatter';

export interface MarkdownDocument {
  markdown: string;
  frontMatter?: string;
}

export interface MarkdownBridge {
  parse(markdown: string): MarkdownDocument;
  serialize(document: MarkdownDocument): string;
}

export function createMarkdownBridge(): MarkdownBridge {
  return {
    parse(markdown) {
      const frontMatter = extractFrontMatterBlock(markdown);

      return {
        markdown: frontMatter?.body ?? markdown,
        frontMatter: frontMatter?.raw,
      };
    },
    serialize(document) {
      if (!document.frontMatter) {
        return document.markdown;
      }

      return `${document.frontMatter}${document.markdown}`;
    },
  };
}
