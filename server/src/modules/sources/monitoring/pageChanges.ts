import { createHash } from 'node:crypto';
import { extractStructuredReaderContent, type StructuredReaderContent } from '../contentParsing.js';

/** Same Reader extraction/noise rules as normal Sources: markup and site chrome are not revisions. */
export function pageVersion(html: string, uri: string) {
  const document = extractStructuredReaderContent(html, uri);
  const text = document.plain_text.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (!text) throw new Error('Fixed page has no readable body; keep the previous baseline');
  return {
    document,
    hash: createHash('sha256').update(text).digest('hex')
  };
}

/** An evidence document, explicitly a page transition, never another article or a new URL. */
export function pageChangeDocument(before: string, after: StructuredReaderContent): StructuredReaderContent {
  const paragraphs = ['Page change — previous captured version', before, 'Page change — current captured version', after.plain_text];
  return {
    ...after,
    plain_text: paragraphs.join('\n\n'),
    image_count: 0,
    image_policy: 'none',
    content_json: {
      type: 'doc',
      content: paragraphs.map(text => ({
        type: 'paragraph',
        content: [{
          type: 'text',
          text
        }]
      }))
    }
  };
}
