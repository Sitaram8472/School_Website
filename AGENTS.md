# AGENTS.md

## Project Overview

EduStream Academy Portal — MERN stack (MongoDB, Express, React, Node.js) school management site with real-time notices, resource sharing, and Gemini AI chat integration.

## Repo Structure

Two independent packages, **not** a monorepo workspace:

- `backend/` — Express 5, Mongoose, CommonJS (`server.js` entrypoint)
- `frontend/` — React 19, Vite 7, Tailwind CSS v4, ES modules
- Root `package.json` — only husky + commitlint (no app code)

## Dev Commands

### Backend
```bash
cd backend && npm install    # first time
cd backend && npm run dev    # starts nodemon on port 5000
```

### Frontend
```bash
cd frontend && npm install   # first time
cd frontend && npm run dev   # Vite dev server on port 5173
cd frontend && npm run lint  # ESLint (react-hooks + react-refresh)
```

There is **no test suite** in either package. No typecheck step either (no TypeScript).

## Environment Variables

Backend requires `backend/.env`. Copy from `backend/.env.example`:
- `MONGO_URL` — MongoDB connection string
- `JWT_SECRET` — secret for JWT tokens
- `PORT` — default 5000
- Optional: `EMAIL_*`, `FRONTEND_URL`

Backend uses `dotenv` and reads from `backend/.env` (not root).

## Commit Convention

Husky runs commitlint on every commit. Message format must be Conventional Commits:

```
feat(frontend): add dark mode toggle
fix(backend): correct token expiry
```

Allowed types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`, `ci`, `revert`.

Scope is optional but recommended (`frontend`, `backend`, `auth`, `api`, etc.).

## Key Conventions

- **Frontend routing**: Uses `HashRouter` (not BrowserRouter) — URLs have `#` prefix
- **Styling**: Tailwind CSS v4 via `@tailwindcss/vite` plugin — no `tailwind.config.js`, uses CSS-first config
- **Frontend API layer**: Axios calls live in `frontend/src/services/`
- **Backend routes**: All under `/api/` prefix (auth, notices, applications, contact, teacher, inquiries)
- **File uploads**: Backend serves static files from `backend/uploads/`
- **No ESLint in backend**: Linting only configured for frontend
- **ESLint frontend rules**: `no-unused-vars` ignores variables matching `^[A-Z_]` (component names, constants)

## Available Skills (`.agents/skills/`)

| Skill | What it does in this repo |
|---|---|
| `conventional-commit` | Reads your staged changes and generates a correctly-formatted Conventional Commit message (e.g. `feat(frontend): ...`) that passes the Husky commitlint hook |
| `mongodb-query-optimizer` | Analyzes slow Mongoose/MongoDB queries in `backend/`, suggests indexes, and explains why a query is slow |
| `nodejs-backend-patterns` | Provides patterns for Express 5 routes, middleware, error handling, and auth — applied to code under `backend/` |
| `wcag-audit-patterns` | Audits React components in `frontend/` against WCAG 2.2, flags violations, and suggests accessible fixes |

## Gotchas

- Backend `package.json` says `"main": "index.js"` but entrypoint is actually `server.js`
- Backend depends on both `mongoose` and `mysql` packages — only MongoDB is actually wired up
- Frontend uses `react-router-dom` v7 with `HashRouter` — if changing router type, update all internal links
- Tailwind v4 uses `@tailwindcss/vite` plugin, not PostCSS — don't look for `postcss.config.js`
