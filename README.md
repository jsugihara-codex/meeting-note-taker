# Meeting Room

Meeting Room is a responsive meeting recorder for laptops and phones. It uses
the OpenAI Realtime API over WebRTC for live transcription, supports
timestamped notes, and provides continuously updated key topics, action items,
meeting chat, and a separate presentation display.

## Run locally

Requirements:

- Node.js 22 or later
- An OpenAI API key

```bash
cp .env.example .env.local
npm install
npm run dev
```

Open `http://localhost:3000`. Microphone access works on localhost and on
secure HTTPS deployments.

## Environment variables

```text
OPENAI_API_KEY=your_openai_api_key
```

The key is read only by server routes. It is never exposed to browser code.

## Deploy to Vercel

1. Import this repository into Vercel.
2. Keep the detected framework preset as **Next.js**.
3. Add `OPENAI_API_KEY` as a secret environment variable for Production,
   Preview, and Development.
4. Deploy.

Vercel uses `npm run build` and serves the Next.js application without a custom
adapter. The separate Meta Display is available at `/display`.

## Useful commands

- `npm run dev` — start local development
- `npm run build` — create the production build
- `npm run start` — run the production build locally
- `npm run lint` — run code-quality checks
