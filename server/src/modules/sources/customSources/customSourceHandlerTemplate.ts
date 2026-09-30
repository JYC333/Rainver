/**
 * Deterministic, config-driven generator for MVP Custom Source handler code.
 *
 * "Generation" here is template-based, not LLM/agent-driven: the source
 * config supplied at draft time (`list_selector`) is enough to produce a
 * genuinely source-specific handler without pulling the full agent/workspace
 * Run pipeline into this feature. See
 * `.agent/architecture/SOURCE_CUSTOM_SOURCE_HANDLERS.md` (Level 3 fallback;
 * frozen).
 *
 * The generated handler never calls `fetch`/`http`/`net` itself — the
 * sandbox bootstrap in `customSourceRunner.ts` unconditionally blocks those
 * APIs (Phase 4 shipped "blocked network", not a controlled fetch channel).
 * Instead, trusted server code (`customSourceCreateFlowService.ts` /
 * `customSourceScanWorker.ts`) fetches `endpoint_url` itself and embeds the
 * fetched (or fixture) HTML directly into `input.json` as
 * `source.config.fetched_html`. The handler is a pure parser over that
 * string, CommonJS so it runs directly under the runner's
 * `require(entrypointPath)` with no compile step.
 */

export interface CustomSourceHandlerTemplateConfig {
  /** CSS class name (e.g. "article" or ".article") identifying repeated list items. Single-page mode is used when omitted. */
  listSelector?: string | null;
}

export const CUSTOM_SOURCE_HANDLER_ENTRYPOINT = "handler.cjs";

export function generateCustomSourceHandlerSource(
  templateConfig: CustomSourceHandlerTemplateConfig,
): string {
  const listSelector = templateConfig.listSelector?.replace(/^\./, "").trim() || null;
  return `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const LIST_SELECTOR = ${JSON.stringify(listSelector)};

function readInput() {
  return JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'input.json'), 'utf8'));
}

function writeOutput(output) {
  fs.writeFileSync(path.resolve(process.cwd(), 'output.json'), JSON.stringify(output));
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function stripTags(html) {
  return html
    .replace(/<script[\\s\\S]*?<\\/script>/gi, ' ')
    .replace(/<style[\\s\\S]*?<\\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\\s+/g, ' ')
    .trim();
}

function extractTagText(html, tag) {
  const match = html.match(new RegExp('<' + tag + '[^>]*>([\\\\s\\\\S]*?)</' + tag + '>', 'i'));
  return match ? stripTags(match[1]).trim() : null;
}

function extractHref(html) {
  const match = html.match(/href\\s*=\\s*["']([^"']+)["']/i);
  return match ? match[1] : null;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
}

function splitBlocksByClass(html, className) {
  const pattern = new RegExp(
    '<[a-zA-Z0-9]+[^>]*class\\\\s*=\\\\s*["\\'][^"\\']*\\\\b' + escapeRegExp(className) + '\\\\b[^"\\']*["\\'][^>]*>',
    'gi',
  );
  const opens = [...html.matchAll(pattern)];
  const blocks = [];
  for (let i = 0; i < opens.length; i++) {
    const start = opens[i].index;
    const end = i + 1 < opens.length ? opens[i + 1].index : html.length;
    blocks.push(html.slice(start, end));
  }
  return blocks;
}

function resolveUrl(href, baseUrl) {
  if (!href) return baseUrl || null;
  try {
    return new URL(href, baseUrl || undefined).toString();
  } catch {
    return baseUrl || null;
  }
}

function bodyOnly(html) {
  const match = html.match(/<body[^>]*>([\\s\\S]*)<\\/body>/i);
  return match ? match[1] : html;
}

function buildSinglePageItems(input, html) {
  const endpointUrl = (input.source && input.source.endpoint_url) || input.source.name;
  const title = (html && extractTagText(html, 'title')) || input.source.name || 'Untitled';
  const excerpt = html ? stripTags(bodyOnly(html)).slice(0, 4000) : null;
  return [
    {
      external_id: sha256(endpointUrl),
      title: String(title).slice(0, 512),
      source_uri: endpointUrl,
      excerpt: excerpt || null,
      metadata: {},
      snapshots: [],
      evidence: excerpt
        ? [{ evidence_type: 'excerpt', title: 'Captured page excerpt', content_excerpt: excerpt.slice(0, 1000), confidence: 0.5 }]
        : [],
    },
  ];
}

function buildListItems(input, html, maxItems) {
  const baseUrl = (input.source && input.source.endpoint_url) || null;
  const blocks = splitBlocksByClass(html || '', LIST_SELECTOR).slice(0, Math.max(1, maxItems));
  return blocks.map((block, index) => {
    const href = extractHref(block);
    const resolved = resolveUrl(href, baseUrl);
    const ownLink = href && resolved && resolved !== baseUrl ? resolved : null;
    const link = resolved || baseUrl || input.source.name;
    const title =
      extractTagText(block, 'a') || extractTagText(block, 'h2') || extractTagText(block, 'h3') || ('Item ' + (index + 1));
    const excerpt = stripTags(block).slice(0, 2000) || null;
    return {
      external_id: sha256(ownLink || (link + '#' + index)),
      title: String(title).slice(0, 512),
      source_uri: link,
      excerpt,
      metadata: {},
      snapshots: [],
      evidence: [],
    };
  });
}

function main() {
  const input = readInput();
  const html = (input.source && input.source.config && input.source.config.fetched_html) || '';
  const maxItems = (input.policy && input.policy.limits && input.policy.limits.max_items) || 20;
  const items = LIST_SELECTOR ? buildListItems(input, html, maxItems) : buildSinglePageItems(input, html);
  writeOutput({
    contract_version: 'custom_source.handler_output.v1',
    cursor: null,
    items,
    diagnostics: { warnings: items.length === 0 ? ['No items extracted from fetched content.'] : [] },
  });
}

main();
`;
}
