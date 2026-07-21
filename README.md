# Meeting Room

Meeting Room uses a local recorder and a hosted Meta Display:

- Recording, OpenAI authentication, live transcription, the final accuracy
  pass, meeting chat, and summaries run on the user's computer.
- Spoken transcription remains background context for meeting intelligence.
  The recorder shows the persistent timestamped Meeting notes field.
- The Meta Display remains on Vercel at the stable `/display` URL and updates
  automatically when the local recorder publishes a chat answer or summary.

## Run the recorder locally

Requirements:

- Node.js 22.13 or later
- An OpenAI API key
- The Vercel origin for the hosted Meta Display
- The same relay token configured locally and in Vercel

Create `.env.local` next to `package.json`:

```text
OPENAI_API_KEY=your_openai_api_key
META_DISPLAY_ORIGIN=https://meeting-note-taker-zeta.vercel.app
NEXT_PUBLIC_META_DISPLAY_ORIGIN=https://meeting-note-taker-zeta.vercel.app
META_DISPLAY_RELAY_TOKEN=the_same_long_random_value_used_in_vercel
```

`OPENAI_API_KEY` and `META_DISPLAY_RELAY_TOKEN` remain server-side.
`NEXT_PUBLIC_META_DISPLAY_ORIGIN` contains only the public display URL and
supplies the **Open Meta Display** link.

Install and run:

```bash
npm install
npm run local
```

Open `http://localhost:3000`. `npm run local` builds the application and starts
the stable local production server without a development file watcher. Restart
it whenever `.env.local` changes because environment variables are loaded when
the local server starts.

## Hosted Meta Display

The Vercel deployment stores the latest presentation state in Upstash Redis so
the display can be open in any browser. Configure these Vercel environment
variables for Production and Preview:

```text
META_DISPLAY_RELAY_TOKEN=the_same_long_random_value_used_locally
UPSTASH_REDIS_REST_URL=your_upstash_redis_rest_url
UPSTASH_REDIS_REST_TOKEN=your_upstash_redis_rest_token
```

Vercel's Upstash integration may instead provide `KV_REST_API_URL` and
`KV_REST_API_TOKEN`; those names are supported as fallbacks.

The hosted display is available at:

```text
https://meeting-note-taker-zeta.vercel.app/display
```

The OpenAI key is not required by the hosted display. Generate a relay token
once with `openssl rand -hex 32`, use the same value locally and in Vercel, and
never commit it.

## How updates reach Meta Display

1. The recorder sends the transcript snapshot, explicit notes, and chat prompt
   through the local `/api/analyze` route.
2. The recorder immediately publishes a thinking state to its local
   `/api/meta-state` route.
3. The local route authenticates to the hosted Vercel relay with
   `META_DISPLAY_RELAY_TOKEN`.
4. The independently opened Meta Display polls the Redis-backed state and shows
   the thinking indicator.
5. When the local OpenAI response returns, the display reveals the new response
   one character at a time.

Only the current display mode, status, title, and response text are stored in
the relay. The latest state expires after six hours. Meeting audio and the
background transcript are not stored by the Meta Display relay.

## OpenAI data path

- The permanent `OPENAI_API_KEY` is read only by local Next.js server routes.
- The local `/api/realtime` route creates a short-lived Realtime session and
  exchanges the browser's WebRTC offer.
- Live transcription uses `gpt-realtime-whisper`, low delay, client-controlled
  2200ms audio commits, and selectable near-field or far-field microphone
  handling.
- Compressed five-minute audio segments remain in browser memory while the
  meeting is active. When recording stops, the local `/api/transcribe` route
  sends each segment to `gpt-4o-transcribe` for the final accuracy pass.
- Chat and summaries use the local `/api/analyze` route and include the
  background transcript, explicit timestamped notes, and prior meeting chat.

If the OpenAI project enforces an IP allowlist, the local computer's public
egress IP must be permitted. The permanent key is never exposed to browser
code.

## Useful commands

- `npm run local` — build and run the recorder locally
- `npm run dev` — run the recorder locally
- `npm run dev:lan` — expose the recorder on a trusted LAN
- `npm run dev:lan:https` — run LAN development with generated HTTPS
- `npm run build` — create a production build
- `npm start` — run the production build locally
- `npm run start:lan` — expose the local production build on a trusted LAN
- `npm run lint` — run code-quality checks
