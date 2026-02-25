# BlogSDK

A minimal static blog generator that builds from Markdown posts to a GitHub Pages site.

## One-time setup (the only manual step)

Before the automatic deployment will work you need to tell GitHub where to publish the site.  
Do this **once** in the repository settings — you never have to touch it again:

1. Go to **Settings → Pages**
2. Under **Build and deployment → Source**, select **GitHub Actions**
3. Save

That's it. From that point on every push to `main` builds and deploys the site automatically — no manual steps, no extra configuration needed.

> **Archiving (optional)** — if you want the live site archived to archive.org / archive.today after each deploy, set the repository variable `ARCHIVE_ENABLED = true` in **Settings → Secrets and variables → Actions → Variables**. Everything else is already wired up.

## Structure

```
posts/          Markdown articles (with YAML frontmatter)
src/templates/  HTML templates for every page type
config/         config.json — site settings, authors, and archive options
scripts/        build.js — the build script
pages/          Built output (generated; not committed)
```

## Writing a Post

Create a `.md` file in `posts/` with frontmatter:

```markdown
---
title: "My Post"
date: 2025-01-01
author: you@example.com        # must match a key in config.json users
description: "A short blurb."
short: mypost                  # optional short URL alias
---

Your Markdown content here…
```

Each post is accessible at:

| URL | Notes |
|---|---|
| `/a/{slug}` | Primary — slugified title |
| `/a/{id}` | Short alphanumeric ID (auto-generated from title; stable) |
| `/a/{short}` | Your `short:` alias from frontmatter |
| `/article/{slug}` | Long-form alias |

## Building Locally

```sh
npm install
npm run build
```

The output lands in `pages/`.

## Deployment

Push to `main` — GitHub Actions builds the site and deploys `pages/` to GitHub Pages automatically.  
Only affected files are rebuilt on incremental pushes (post-only changes don't re-render templates).

### Enabling Archiving

After each deploy, the workflow can submit the live URL to **archive.org** and **archive.today**.  
Enable it by adding a repository variable in **Settings → Variables → Actions**:

| Variable | Value |
|---|---|
| `ARCHIVE_ENABLED` | `true` |
| `ARCHIVE_ORG` | `true` (default) or `false` to skip |
| `ARCHIVE_TODAY` | `true` (default) or `false` to skip |

Also set `site.url` in `config/config.json` to your live GitHub Pages URL.
