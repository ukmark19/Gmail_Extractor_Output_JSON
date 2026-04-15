# Gmail Query Exporter

## Overview

A production-quality Gmail search and export tool for power users. Allows advanced email searching via the Gmail API and exports results as structured JSON files optimized for ChatGPT knowledge base ingestion.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **Frontend**: React + Vite + Tailwind CSS (artifacts/gmail-exporter)
- **API framework**: Express 5 (artifacts/api-server)
- **Database**: PostgreSQL + Drizzle ORM (lib/db)
- **Auth**: Google OAuth 2.0 (Gmail read-only scope, session-based)
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Architecture

### Database Schema
- `users` — Google OAuth users with encrypted tokens
- `saved_searches` — User-saved Gmail search queries with structured fields
- `export_logs` — Audit log of all exports performed

### Backend Services
- `artifacts/api-server/src/lib/gmail.ts` — OAuth client, HTML stripping, email part extraction
- `artifacts/api-server/src/lib/query-builder.ts` — Gmail query string builder
- `artifacts/api-server/src/lib/export-formatter.ts` — JSON export formatters (raw, AI-optimized, JSONL)
- `artifacts/api-server/src/routes/auth.ts` — Google OAuth routes
- `artifacts/api-server/src/routes/gmail.ts` — Gmail search, message detail, labels
- `artifacts/api-server/src/routes/export.ts` — Email export endpoint
- `artifacts/api-server/src/routes/saved-searches.ts` — Saved searches CRUD
- `artifacts/api-server/src/routes/export-logs.ts` — Audit log

### Frontend Pages
- `/` — Landing/auth page with Google sign-in
- `/search` — Main search interface with form, results, preview, export
- `/saved-searches` — Manage saved searches
- `/export-history` — Export audit log

## Required Environment Variables

Must be set in Replit Secrets:
- `GOOGLE_CLIENT_ID` — From Google Cloud Console
- `GOOGLE_CLIENT_SECRET` — From Google Cloud Console
- `GOOGLE_REDIRECT_URI` — OAuth callback URL (e.g. `https://your-app.replit.app/api/auth/google/callback`)
- `SESSION_SECRET` — Already set

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally
- `pnpm --filter @workspace/gmail-exporter run dev` — run frontend locally

## Export Formats

1. **Raw JSON** — Full Gmail data for archiving
2. **AI-Optimized JSON** — Cleaned and normalized for LLM ingestion
3. **JSONL** — One document per line for embedding workflows
