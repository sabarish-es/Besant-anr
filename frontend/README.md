# React frontend

Standalone React + TypeScript + Vite application. All screens are in `src/`; the backend is the direct Cloudflare Worker in `../server/`. It does not use Next.js, Vinext, or development role selectors.

Install dependencies at the repository root and follow `../SETUP_WINDOWS.md` to configure `.dev.vars` and the empty local database. Then:

```powershell
npx pnpm@11.25.0 dev
```

Frontend: <http://127.0.0.1:5173>. API: <http://127.0.0.1:5174>. Vite proxies `/api` and translates only the local frontend's own Origin for protected writes.

`src/App.tsx` manages sign-in, sessions, password changes, and a lazy-loaded dashboard. `src/pages/hub.tsx` contains portal screens. `src/components/student-review-card.tsx` displays the current student's branch review URL supplied by the authenticated API. Edit `src/styles.css` for the blue theme.

Use `frontend/.env` only for optional `FRONTEND_PORT` and `API_TARGET` development overrides. Never put authentication secrets, passwords, or Supabase keys in frontend variables. Production browser calls are relative `/api/*` requests at the same HTTPS origin; no production API URL variable is needed.

`npx pnpm@11.25.0 build` at the root checks TypeScript, produces `frontend/dist/`, and checks the Worker bundle. Production serves that folder with Worker Static Assets and routes `/api/*` to the backend. Follow `../DEPLOY_FREE.md` to deploy both together. Uploading only the frontend to an unrelated host will not supply the required login, database, or API.
