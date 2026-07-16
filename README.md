# Meeting Room

Meeting Room is a responsive meeting recorder for laptops and phones. It uses
the OpenAI Realtime API over WebRTC for live transcription, supports
timestamped notes, and provides transcript-grounded meeting chat with a
separate presentation display. A second, higher-accuracy transcription pass
corrects the completed transcript after recording stops.

## Run locally

Requirements:

- Node.js 22 or later
- An OpenAI API key
- An Upstash Redis database for sharing Meta Display state across browsers

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
UPSTASH_REDIS_REST_URL=your_upstash_redis_rest_url
UPSTASH_REDIS_REST_TOKEN=your_upstash_redis_rest_token
```

The key is read only by server routes. It is never exposed to browser code.
When recording starts, the server creates a short-lived Realtime client secret;
the browser then streams a cloned microphone track directly to OpenAI over
WebRTC. The live session uses `gpt-realtime-whisper`, balanced (`medium`) delay,
client-controlled 2200ms audio commits, and a selectable near-field or
far-field microphone profile instead of silence detection. The browser also
keeps compressed five-minute audio segments in memory. When recording stops,
Vercel temporarily relays those segments to `gpt-4o-transcribe` for a final
accuracy pass and does not persist the audio.
The Redis REST credentials remain server-side and store only the latest Meta
Display state, which expires after six hours. Local development can use an
in-memory fallback, but Vercel requires Redis so an independently opened Meta
Display receives reliable updates.

## Deploy to Vercel

1. Import this repository into Vercel.
2. Keep the detected framework preset as **Next.js**.
3. Add an Upstash Redis database from the Vercel Marketplace or attach an
   existing Upstash database.
4. Add `OPENAI_API_KEY`, `UPSTASH_REDIS_REST_URL`, and
   `UPSTASH_REDIS_REST_TOKEN` as secret environment variables for Production,
   Preview, and Development.
5. Deploy.

Vercel uses `npm run build` and serves the Next.js application without a custom
adapter. The separate Meta Display is available at the stable `/display` URL.
It polls the shared state relay every 300ms, so transcript-chat questions
immediately show the thinking indicator and then the generated answer without
opening or refreshing the display page.

## Useful commands

- `npm run dev` — start local development
- `npm run build` — create the production build
- `npm run start` — run the production build locally
- `npm run lint` — run code-quality checks
