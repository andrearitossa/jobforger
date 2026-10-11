# jobforger

Job application workspace: keep your career profile, write LaTeX CVs and cover letters with an AI editor and live PDF preview, and track applications with AI-tailored documents and answers.

**Stack:** Vite + React SPA, one [Hono](https://hono.dev) Pages Function (`functions/api/[[path]].js`), Cloudflare D1, OpenAI, LaTeX compiled via [latex.ytotech.com](https://latex.ytotech.com).

## Develop

```sh
npm install
npx wrangler d1 execute jobforger-db --local --file migrations/0000_schema.sql
printf 'SESSION_SECRET=dev\nOPENAI_API_KEY=sk-...\n' > .dev.vars
npm run preview        # build + wrangler pages dev on :8788
```

For hot reload, run `npm run dev` alongside `npx wrangler pages dev dist` (Vite proxies `/api`).

## Deploy

```sh
npx wrangler pages secret put OPENAI_API_KEY --project-name jobforger
npm run deploy
```

`SESSION_SECRET` is a Pages secret; `OPENAI_MODEL` (default `gpt-6-luna`) and `LATEX_COMPILE_URL` live in `wrangler.toml`.
