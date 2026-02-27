#!/usr/bin/env node
/**
 * BlogSDK Build Script
 *
 * Reads:  /posts (markdown with frontmatter), /src/templates, /config/config.json
 * Writes: /pages
 *
 * Article URLs (all resolve to the same content):
 *   /a/{slug}        primary - slugified title
 *   /a/{id}          short alphanumeric ID (redirect -> slug)
 *   /a/{short}       optional frontmatter alias  (redirect -> slug)
 *   /article/{slug}  long-form alias             (redirect -> /a/{slug})
 *
 * Run:
 *   node scripts/build.js               - full rebuild
 *   node scripts/build.js --changed     - only rebuild files that changed
 *     (pass changed file paths as extra args, or reads CHANGED_FILES env var)
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { marked }  = require('marked');
const matter      = require('gray-matter');
const { minify } = require('html-minifier-next');

// ── Paths ──────────────────────────────────────────────────────────────────
const ROOT      = path.join(__dirname, '..');
const POSTS_DIR = path.join(ROOT, 'posts');
const TMPL_DIR  = path.join(ROOT, 'src', 'templates');
const FRAW_DIR  = path.join(ROOT, 'src', 'fraw');
const CFG_FILE  = path.join(ROOT, 'config', 'config.json');
const OUT_DIR   = path.join(ROOT, 'pages');

// ── Config ─────────────────────────────────────────────────────────────────
const config = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
const site   = config.site  || {};
const users  = config.data?.users    || {};
const cos    = config.data?.companies || {};

// ── Helpers ────────────────────────────────────────────────────────────────

/** Convert a string to a URL-safe slug */
function slugify(str) {
  return String(str)
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();
}

/**
 * Generate a short, stable alphanumeric ID from a string (djb2-based).
 * The same title always produces the same ID, so links stay valid as long
 * as the post title doesn't change.
 */
function shortId(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h, 31) + str.charCodeAt(i) | 0;
  }
  return (Math.abs(h) >>> 0).toString(36).slice(0, 6).padStart(4, '0');
}

/** Replace {{dotted.key}} placeholders in a template string */
function render(tmpl, vars) {
  return tmpl.replace(/\{\{([^}]+)\}\}/g, (_, key) => {
    const val = key.trim().split('.').reduce((o, k) => o?.[k], vars);
    return val != null ? val : '';
  });
}

/** Ensure a directory (and parents) exists */
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/** Write a file, creating parent dirs as needed */
async function write(filePath, content) {
  const result = await minify(content, {
    removeAttributeQuotes: true,
    removeOptionalTags: true,
    removeComments: true,
    collapseWhitespace: true,
    removeEmptyAttributes: true,
    minifyCSS: true,
    minifyJS: true,
    removeRedundantAttributes: true,
    removeScriptTypeAttributes: true,
    removeStyleLinkTypeAttributes: true,
    useShortDoctype: true
  });
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, result, 'utf8');
  console.log('  Built:', path.relative(ROOT, filePath));
}

/** Recursively copy files from src/fraw to pages, preserving structure */
function copyFrawFiles() {
  if (!fs.existsSync(FRAW_DIR)) return;

  function walkDir(srcDir, outRelative = '') {
    const entries = fs.readdirSync(srcDir, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = path.join(srcDir, entry.name);
      const outPath = path.join(OUT_DIR, outRelative, entry.name);

      if (entry.isDirectory()) {
        walkDir(srcPath, path.join(outRelative, entry.name));
      } else {
        ensureDir(path.dirname(outPath));
        fs.copyFileSync(srcPath, outPath);
        console.log('  Copied:', path.relative(ROOT, outPath));
      }
    }
  }

  walkDir(FRAW_DIR);
}

/** Load a template by name (without extension) */
function tmpl(name) {
  return fs.readFileSync(path.join(TMPL_DIR, `${name}.html`), 'utf8');
}

/** Build a minimal HTML redirect page */
function redirect(target) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="refresh" content="0;url=${target}">
  <title>Redirecting…</title>
</head>
<body>
  <p>Redirecting… <a href="${target}">${target}</a></p>
</body>
</html>`;
}

/**
 * Auto-generate a table-of-contents fragment from rendered HTML.
 * Picks up <h2> and <h3> headings; injects id attributes into them too.
 */
function buildToc(html) {
  const toc  = [];
  let modified = html;

  // Inject id attrs and collect headings
  modified = modified.replace(/<(h[23])>(.*?)<\/\1>/gi, (_, tag, text) => {
    const clean = text.replace(/<[^>]+>/g, ''); // strip inner tags for id
    const id    = slugify(clean);
    toc.push({ tag, text, id });
    return `<${tag} id="${id}">${text}</${tag}>`;
  });

  const tocHtml = toc
    .map(({ tag, text, id }) => {
      const indent = tag === 'h3' ? ' style="margin-left:1rem"' : '';
      return `<li${indent}><a href="#${id}">${text}</a></li>`;
    })
    .join('\n        ');

  return { modifiedHtml: modified, tocHtml };
}

// ── Core builders ──────────────────────────────────────────────────────────

/**
 * Parse and build a single post.
 * Returns a post-info object for use in index pages.
 */
async function buildPost(filename) {
  const raw   = fs.readFileSync(path.join(POSTS_DIR, filename), 'utf8');
  const { data: fm, content: mdContent } = matter(raw);

  const title  = fm.title || path.basename(filename, '.md');
  const slug   = slugify(title);
  const id     = fm.id || shortId(title);
  const short  = fm.short;

  // Resolve author & company
  const authorKey  = fm.author || '';
  const authorData = users[authorKey] || {};
  const compData   = cos[authorData.company] || null;

  const companyHtml = compData
    ? ` @ <a href="${compData.contact}">${compData.display}</a>`
    : '';

  const dateStr = fm.date
    ? new Date(fm.date).toLocaleDateString('en-US', {
        year: 'numeric', month: 'long', day: 'numeric',
      })
    : '';

  // Render markdown → HTML, build TOC
  const rawHtml = marked.parse(mdContent);
  const { modifiedHtml, tocHtml } = buildToc(rawHtml);

  const html = render(tmpl('article'), {
    site: { title: site.title || 'BlogSDK', url: site.url || '' },
    page: {
      title,
      description: fm.description || '',
      content:     modifiedHtml,
      date:        dateStr,
      toc:         tocHtml,
      author: {
        fullname:     authorData.Name || authorKey,
        contact:      authorData.contact || '#',
        company_html: companyHtml,
      },
    },
  });

  // Primary URL: /a/{slug}/
  await write(path.join(OUT_DIR, 'a', slug, 'index.html'), html);

  // Short ID redirect (if different from slug)
  if (id !== slug) {
    await write(path.join(OUT_DIR, 'a', id, 'index.html'), redirect(`/a/${slug}/`));
  }

  // Short alias redirect (if defined and different)
  if (short && short !== slug && short !== id) {
    await write(path.join(OUT_DIR, 'a', short, 'index.html'), redirect(`/a/${slug}/`));
  }

  // /article/{slug}/ → /a/{slug}/
  await write(path.join(OUT_DIR, 'article', slug, 'index.html'), redirect(`/a/${slug}/`));

  return {
    title,
    slug,
    id,
    short,
    date:        fm.date,
    dateStr,
    description: fm.description || '',
    author: {
      fullname: authorData.Name || authorKey,
      contact:  authorData.contact || '#',
      company:  compData,
    },
  };
}

/** Build home, articles, and editors index pages */
async function buildIndexPages(posts) {
  // Sort newest first
  const sorted = [...posts].sort((a, b) => {
    if (!a.date && !b.date) return 0;
    if (!a.date) return 1;
    if (!b.date) return -1;
    return new Date(b.date) - new Date(a.date);
  });

  // ── home ──
  const recentHtml = sorted
    .slice(0, 5)
    .map(p => postListItem(p))
    .join('\n        ');

  await write(
    path.join(OUT_DIR, 'home', 'index.html'),
    render(tmpl('home'), {
      site: { title: site.title || 'BlogSDK', description: site.description || '' },
      page: { recent_posts: recentHtml },
    }),
  );

  // Redirect root to /home/
  await write(path.join(OUT_DIR, 'index.html'), redirect('/home/'));

  // ── articles ──
  const allPostsHtml = sorted.map(p => postListItem(p)).join('\n        ');
  await write(
    path.join(OUT_DIR, 'articles', 'index.html'),
    render(tmpl('articles'), {
      site: { title: site.title || 'BlogSDK' },
      page: { posts: allPostsHtml },
    }),
  );

  // ── editors ──
  const editorsHtml = Object.entries(users)
    .map(([email, u]) => {
      const company = cos[u.company];
      const compLine = company
        ? ` &mdash; <a href="${company.contact}">${company.display}</a>`
        : '';
      return `<li>
          <span class="editor-name"><a href="${u.contact || '#'}">${u.Name || email}</a></span>
          <span class="editor-meta">${compLine}</span>
        </li>`;
    })
    .join('\n        ');

  await write(
    path.join(OUT_DIR, 'editors', 'index.html'),
    render(tmpl('editors'), {
      site: { title: site.title || 'BlogSDK' },
      page: { editors: editorsHtml },
    }),
  );
}

/** HTML fragment for a single post in a list */
function postListItem(p) {
  const compLine = p.author.company
    ? ` @ <a href="${p.author.company.contact}">${p.author.company.display}</a>`
    : '';
  return `<li>
          <a class="post-title" href="/a/${p.slug}/">${p.title}</a>
          <p class="post-meta">
            <a href="${p.author.contact}">${p.author.fullname}</a>${compLine}
            ${p.dateStr ? `&mdash; ${p.dateStr}` : ''}
          </p>
          ${p.description ? `<p class="post-description">${p.description}</p>` : ''}
        </li>`;
}

// ── Entry point ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const incrementalMode = args.includes('--changed');

/**
 * In incremental mode the caller provides a space-separated list of changed
 * file paths via the CHANGED_FILES env var (set by the GitHub Actions step).
 * We decide what to rebuild based on those paths:
 *   - Any file in src/templates or config/ changed → full rebuild
 *   - Only files in posts/ changed              → rebuild those posts + indexes
 */
async function run() {
  ensureDir(OUT_DIR);

  let allPostFiles = fs.readdirSync(POSTS_DIR).filter(f => f.endsWith('.md'));

  if (incrementalMode) {
    const changedFiles = (process.env.CHANGED_FILES || '')
      .split('\n')
      .map(f => f.trim())
      .filter(Boolean);

    const needsFullRebuild = changedFiles.some(f =>
      f.startsWith('src/templates/') ||
      f.startsWith('config/') ||
      f === 'template.html',
    );

    const needsFrawCopy = changedFiles.some(f =>
      f.startsWith('src/fraw/'),
    );

    if (!needsFullRebuild && !needsFrawCopy) {
      const changedPosts = changedFiles
        .filter(f => f.startsWith('posts/') && f.endsWith('.md'))
        .map(f => path.basename(f));

      if (changedPosts.length > 0) {
        console.log('Incremental build — changed posts:', changedPosts.join(', '));
        // Build only the changed posts; load rest from cached manifest if available
        const manifestPath = path.join(OUT_DIR, 'posts-manifest.json');
        let cachedPosts = [];
        if (fs.existsSync(manifestPath)) {
          cachedPosts = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        }

        const builtNow = await Promise.all(changedPosts
          .filter(f => allPostFiles.includes(f))
          .map(buildPost));

        // Merge: replace cached entries for rebuilt posts, keep rest
        const builtSlugs = new Set(builtNow.map(p => p.slug));
        const merged = [
          ...cachedPosts.filter(p => !builtSlugs.has(p.slug)),
          ...builtNow,
        ];

        await buildIndexPages(merged);
        fs.writeFileSync(manifestPath, JSON.stringify(merged, null, 2));
        return;
      }
    }

    if (needsFullRebuild || needsFrawCopy) {
      console.log('Full rebuild triggered by template/config/fraw changes.');
    }
  }

  // Full rebuild
  console.log('Building all posts…');
  const posts = await Promise.all(allPostFiles.map(buildPost));
  await buildIndexPages(posts);

  // Copy static fraw files
  console.log('Copying fraw files…');
  copyFrawFiles();

  // Save manifest for future incremental builds
  fs.writeFileSync(
    path.join(OUT_DIR, 'posts-manifest.json'),
    JSON.stringify(posts, null, 2),
  );

  console.log('Done.');
}

run();
