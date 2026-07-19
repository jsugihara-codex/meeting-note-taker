# Meeting Room

Meeting Room is a responsive meeting recorder designed to run as one Next.js
application on Vercel. It records on laptops and phones, captures a background
transcript for meeting intelligence, supports timestamped notes and meeting
chat, generates structured summaries, and publishes answers or summaries to a
separate Meta Display at `/display`.

## Vercel architecture

- The permanent OpenAI API key remains in Vercel server-side environment
  variables and is never included in browser code.
- `/api/realtime` creates a short-lived OpenAI Realtime session and exchanges
  the browser's SDP offer. The microphone then streams to OpenAI over WebRTC,
  which does not require a custom WebSocket server.
- `/api/analyze` uses the Responses API for transcript-grounded chat and
  structured meeting summaries.
- `/api/transcribe` sends compressed five-minute audio segments for the final
  transcription accuracy pass after recording stops.
- `/api/meta-state` stores the latest presentation state in Upstash Redis so an
  independently opened Meta Display can refresh automatically.

## Deploy to Vercel

1. Import this repository into Vercel.
2. Keep the framework preset set to **Next.js**.
3. Attach an Upstash Redis database from the Vercel Marketplace, or use an
   existing Upstash database.
4. Add these encrypted environment variables for Production and Preview:

   ```text
   OPENAI_API_KEY=your_openai_api_key
   UPSTASH_REDIS_REST_URL=your_upstash_redis_rest_url
   UPSTASH_REDIS_REST_TOKEN=your_upstash_redis_rest_token
   ```

   Vercel's Upstash integration may create `KV_REST_API_URL` and
   `KV_REST_API_TOKEN` instead. The application supports those names as
   fallbacks, so do not duplicate the credentials.

5. Deploy the project.

The recorder is available at the deployment root and the Meta Display is
available at `/display`. Both surfaces must use the same Vercel project so they
share the same Redis-backed meeting state.

Do not configure `META_DISPLAY_ORIGIN`,
`NEXT_PUBLIC_META_DISPLAY_ORIGIN`, or `META_DISPLAY_RELAY_TOKEN` for the normal
single-project deployment. Those variables were used by the previous
local-recorder/hosted-display architecture.

## Local development

Requirements:

- Node.js 22
- An OpenAI API key

Create `.env.local` next to `package.json`:

```text
OPENAI_API_KEY=your_openai_api_key
UPSTASH_REDIS_REST_URL=your_upstash_redis_rest_url
UPSTASH_REDIS_REST_TOKEN=your_upstash_redis_rest_token
```

Redis is optional for local development; without it, Meta Display state uses
process memory and is available only to the running local Next.js server.

Then run:

```bash
npm install
npm run dev
```

Open `http://localhost:3000`. Microphone access works on localhost and on the
secure HTTPS URL provided by Vercel.

## OpenAI data path

- Live transcription uses `gpt-realtime-whisper`, low delay, client-controlled
  2200ms audio commits, and selectable near-field or far-field microphone
  handling.
- The browser keeps compressed audio segments in memory only while the meeting
  is active. Vercel relays each segment to `gpt-4o-transcribe` for the final
  accuracy pass and does not persist the audio.
- Chat and summaries send the current transcript, explicit timestamped notes,
  and prior meeting-chat exchanges through server routes.
- Summaries group the discussion into high-level Key topics, followed by Key
  decisions, Next steps, and explicit Notes.

If the OpenAI project enforces an IP allowlist, requests made by Vercel server
routes must be permitted by that policy. Realtime browser traffic uses a
short-lived session authorization; the permanent OpenAI key always remains on
the server.

## Useful commands

- `npm run dev` — start local development
- `npm run dev:lan` — expose local development on a trusted LAN
- `npm run dev:lan:https` — run LAN development with generated HTTPS
- `npm run build` — create the Vercel production build
- `npm start` — run the production build locally
- `npm run start:lan` — expose the production build on a trusted LAN
- `npm run lint` — run code-quality checks
