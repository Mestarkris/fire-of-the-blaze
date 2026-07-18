# Fire of the Blaze

**Live: [fireoftheblaze.fun](https://fireoftheblaze.fun)**

A 2D top-down arena shooter where your **live Blaze chat is the game master**.
Built for the [Blaze Builder Challenge](https://backstage.blaze.stream/announcing-the-blaze-builder-challenge/).

You are the player on screen. Everything happening in your channel's chat feed
changes the run in real time, using Blaze's official OAuth, Chat, and
real-time Events APIs — no polling, no fake data.

| Live Blaze event            | In-game effect                                |
|------------------------------|------------------------------------------------|
| `!spawn` in chat              | throws in another enemy                        |
| `!heal` in chat                | restores 20 HP                                  |
| `!shield` in chat              | 3 seconds of invincibility                      |
| `!slow` in chat                | slows every enemy for 5 seconds                 |
| `channel.follow`              | spawns a temporary ally that auto-fires for you |
| `channel.subscribe` / gift sub | triggers a boss wave                            |
| `channel.vote`                | summons a horde sized to the vote amount        |

Score is tied to your real Blaze display name and saved to a local leaderboard.

## How it's wired to the Blaze API

- **OAuth (Authorization Code + PKCE)** — `server.js` calls
  `POST /bapi/oauth2/generate-auth-url` and `POST /bapi/oauth2/token` to log
  the streamer in and get a User Access Token. The Client Secret and PKCE
  verifier never touch the browser.
- **Users API** — `GET /v1/users/profile` resolves the logged-in streamer's
  display name, avatar, and channel id.
- **Events API** — the server opens a Socket.IO connection to
  `https://blaze.stream` (path `/ws`), waits for `session_welcome`, then calls
  `POST /v1/events/subscriptions` to subscribe that session to
  `channel.chat.message`, `channel.follow`, `channel.subscribe`,
  `channel.subscription.gift`, and `channel.vote` for the streamer's channel.
  Notifications are relayed to the browser over the server's own Socket.IO
  connection and drive the gameplay in `public/game.js`.

## Setup

### 1. Register your app on Blaze

Go to <https://dev.blaze.stream/applications/new> and create an application:

- **Application Name**: whatever you like, e.g. "Fire of the Blaze"
- **OAuth Redirect URL**: `http://localhost:3000/auth/callback` (for local
  testing — click **Add**, then **Create Application**)

Copy the **Client ID** and **Client Secret** from the app's Manage page.

### 2. Configure environment variables

```bash
cp .env.example .env
```

Edit `.env` and fill in:

```
BLAZE_CLIENT_ID=...
BLAZE_CLIENT_SECRET=...
BLAZE_REDIRECT_URI=http://localhost:3000/auth/callback
SESSION_SECRET=any-random-string
```

### 3. Install and run

```bash
npm install
npm start
```

Open <http://localhost:3000>, click **Log in with Blaze**, approve access,
and you'll land in the arena. Open your Blaze channel chat in another tab (or
have someone chat while you stream) and type `!spawn`, `!heal`, `!shield`, or
`!slow` to see it affect the game live.

## Notes for judges / demo day

- The leaderboard persists to `leaderboard.json` on the server (simple file
  storage — swap for a real database for production use).
- Requested OAuth scopes are kept minimal (`users.read`, `offline.access`) —
  the game only reads identity and chat activity, it doesn't post or moderate
  anything on your behalf.
- If you want the game to also **post** to chat (e.g. announce boss kills),
  request the `channel.moderate` scope in `server.js` and call
  `POST /v1/chats/messages` from the server — left out here to keep the
  requested permissions minimal for the demo.

## Known limitations (3-day hackathon scope)

- Single active game session per login (no multiplayer arena yet).
- Leaderboard is local to the machine running the server — fine for a demo,
  not for the real launch.
- No mobile touch controls yet (keyboard + mouse only).
