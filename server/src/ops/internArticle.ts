import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { openDb } from '../db/db.js';
import type { WsHub } from '../realtime/wsHub.js';
import { appendAudit } from '../audit/auditLog.js';
import { config } from '../config.js';
import { publishInternThread, type InternMediaAttachment } from '../intern/intern.js';
import { buildXAdapter } from '../intern/xAdapter.js';

type ArticleBundle = {
  posts: string[];
  media?: { path: string; mimeType?: InternMediaAttachment['mimeType'] }[];
  actor?: string;
};

const MIME_BY_EXT: Record<string, InternMediaAttachment['mimeType']> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

function usage(): never {
  throw new Error('usage: node server/dist/ops/internArticle.js <article-bundle.json>');
}

function bundlePath(raw: string, root: string): string {
  return path.isAbsolute(raw) ? raw : path.resolve(root, raw);
}

function loadBundle(file: string): ArticleBundle {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as ArticleBundle;
  if (!Array.isArray(parsed.posts) || parsed.posts.length < 2) {
    throw new Error('article bundle must include at least two posts');
  }
  for (const [index, post] of parsed.posts.entries()) {
    if (typeof post !== 'string' || !post.trim()) throw new Error(`post ${index + 1} is empty`);
    if (post.length > 240) throw new Error(`post ${index + 1} is ${post.length} chars; max is 240`);
  }
  if (parsed.media && (!Array.isArray(parsed.media) || parsed.media.length > 4)) {
    throw new Error('article bundle media must contain zero to four images');
  }
  return parsed;
}

function loadMedia(bundle: ArticleBundle, root: string): InternMediaAttachment[] {
  return (bundle.media ?? []).map((entry, index) => {
    const file = bundlePath(entry.path, root);
    const ext = path.extname(file).toLowerCase();
    const mimeType = entry.mimeType ?? MIME_BY_EXT[ext];
    if (!mimeType) throw new Error(`media ${index + 1} has unsupported extension ${ext || '(none)'}`);
    const size = statSync(file).size;
    if (size <= 0 || size > 5 * 1024 * 1024) {
      throw new Error(`media ${index + 1} must be between 1 byte and 5 MB`);
    }
    return { bytes: readFileSync(file), mimeType };
  });
}

async function main() {
  const file = process.argv[2];
  if (!file) usage();
  const absolute = path.resolve(file);
  const bundle = loadBundle(absolute);
  const db = openDb(config.dbPath);
  const hub = { publish: () => {}, publishThrottled: () => {} } as unknown as WsHub;

  try {
    const result = await publishInternThread(
      db,
      hub,
      buildXAdapter(),
      bundle.posts,
      loadMedia(bundle, path.dirname(absolute)),
    );
    appendAudit(db, bundle.actor ?? 'operator:codex', 'intern_article_thread', {
      postIds: result.posts.map((post) => post.publishedId),
      mediaCount: bundle.media?.length ?? 0,
      bundle: absolute,
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
