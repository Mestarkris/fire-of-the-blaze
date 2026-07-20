# Fire of the Blaze

**Live: [fireoftheblaze.fun](https://fireoftheblaze.fun)**

A pixel-art arena shooter where your **live Blaze chat is the game master** — built for the [Blaze Builder Challenge](https://backstage.blaze.stream/announcing-the-blaze-builder-challenge/).

## Why this exists

Most stream-integrated games treat chat as a sidebar — a feed to glance at while the "real" game runs independently. Fire of the Blaze inverts that: Blaze's real-time Events API drives the arena directly. A `!spawn` in chat throws in an enemy *this frame*, not on the next poll; a sub triggers a boss wave the instant it lands; a big on-chain tip can flip the whole run. The point is to demonstrate that Blaze's WebSocket event stream is fast and reliable enough to be a core gameplay input, not just a notification ticker.

## Features

### Blaze API integration

- **OAuth (Authorization Code + PKCE)** — `server.js` calls `POST /bapi/oauth2/generate-auth-url` and `POST /bapi/oauth2/token` to log the streamer in and mint a User Access Token, requesting only the `users.read` and `offline.access` scopes.
- **Users API** — `GET /v1/users/profile` resolves the logged-in streamer's display name, avatar, and channel ID (a user's own channel ID matches their user ID).
- **Events API (real-time)** — the server opens a Socket.IO connection to `https://blaze.stream` (path `/ws`), waits for `session_welcome`, then calls `POST /v1/events/subscriptions` to subscribe that session to six event types on the streamer's channel: `channel.chat.message`, `channel.follow`, `channel.subscribe`, `channel.subscription.gift`, `channel.vote`, and `channel.thanks` (on-chain tips). Notifications are relayed over the server's own Socket.IO connection to the browser, where they drive gameplay directly:
  | Live Blaze event | In-game effect |
  |---|---|
  | `!spawn` in chat | throws in another enemy |
  | `!heal` in chat | restores 20 HP |
  | `!shield` in chat | 3 seconds of invincibility |
  | `!slow` in chat | slows every enemy for 5 seconds |
  | any other chat message | scrolls through the on-screen event ticker |
  | `channel.follow` | spawns a temporary ally that auto-fires at the nearest enemy for 10s |
  | `channel.subscribe` / gift sub | triggers a boss wave |
  | `channel.vote` | summons a horde sized to the vote amount (1 enemy per 5 votes, capped at 12) |
  | `channel.thanks` (tip), small | spawns a one-hit-kill "loot" enemy worth a big score bonus |
  | `channel.thanks` (tip), medium | unlocks the electric weapon for 15 seconds |
  | `channel.thanks` (tip), large | MEGA TIP banner + an immediate boss wave |
- **Leaderboard** — persisted to `leaderboard.json` on the server, tied to the player's real Blaze display name and avatar; top 10 shown after every run.

### Wave & difficulty progression

- Waves last 30 seconds each. Every 5th wave spawns a boss pack (1–2 bosses plus 3 regular enemies).
- The enemy type pool grows as waves climb — new types phase in gradually (starting with chaser/grunt on wave 1, all the way through the elemental elites unlocking one-by-one through wave 14) so the threat mix deepens instead of dumping everything on the player at once.
- **Danger waves** — every 3rd wave (every *other* wave from wave 10 onward), skipping boss waves — trade crowd size for individual toughness: fewer enemies spawn, but they arrive with +60% HP and +15% speed and a pulsing red glow so the buff is visible at a glance.
- From wave 10, a hard-mode multiplier makes the entire enemy roster progressively tankier and faster on top of the normal per-wave creep, and enemies arrive at a faster pace — this is what makes the back half of a run noticeably harder rather than plateauing.
- Two health pickups are guaranteed to spawn every wave (one in the first half, one in the second).

### Enemy types & AI

Sixteen enemy types in total:

- **Base roster** — chaser (direct homing chase), grunt (one-hit fodder), swarmer (spawns in clusters of 3–4, tiny/fast/weak), sniper (kites at range and fires ranged shots), dasher (wanders, telegraphs, then bursts into a fast dash), brute (tanky, kites at range, the hardest-hitting ranged shot in the original roster), boss (large, high-HP, spawned on boss waves), and loot (one-hit-kill, high score payout — spawned only by small tips, never in the normal pool).
- **Ten elemental elites**, all driven by one shared kiting-AI behavior read from a per-type attack config, each with a distinct ranged attack: archer (fast bolt), frost (bolt that chills — saps the player's speed), toxic (bolt with poison damage-over-time plus a lingering ground hazard pool), stormcaller (homing bolt), acid (bolt that leaves a ground hazard pool), and pyro (bolt with burn damage-over-time) as the faster "light" elites; bomber, frostguard, plague, and inferno as tankier "heavy" elites that lob splash-damage grenades instead of direct bolts, several also applying chill, poison, or a ground hazard on top of the splash.

### Weapon pickup system

The default gun plus ten timed pickups (15 seconds each), collected from pulsing diamond pickups that spawn periodically on the field (up to 3 at a time, each expiring after 25 seconds if ignored):

`spread` (3-way shot) · `rapid` (fast fire rate) · `electric` (continuous beam, auto-tracks the nearest enemy in its line) · `ricochet` (bounces off arena walls, pierces multiple enemies) · `shotgun` (5-pellet spread with heavy knockback) · `rocket` (splash-damage explosive) · `flamethrower` (continuous damage cone) · `ice` (chills whatever it hits) · `poison` (damage-over-time dart) · `laser` (near-instant piercing bolt through a lined-up crowd)

A HUD badge shows the active weapon and a countdown bar for its remaining duration.

### Health pickups

Pulsing pixel-heart icons — distinct in shape from the weapon diamonds — restore 25 HP on contact and expire after 25 seconds if uncollected. Separate from the instant +20 HP granted by the `!heal` chat command.

### Player shield ability

**Shift** (desktop) or the dedicated shield button (mobile touch controls) grants 2 seconds of personal invincibility on a 12-second cooldown, with a HUD badge showing "SHIELD READY" or a countdown. It shares the same underlying timer as chat-granted shields (`!shield`, tip rewards), so overlapping sources extend the shield rather than cutting each other short.

### Background tier changes

A fully procedural war-torn backdrop — no image assets — built from layered gradient sky/ground, hand-drawn trees at three depths, craters, barbed wire, and drifting fog, baked to an offscreen canvas layer for performance. Four distinct color palettes shift the mood every 4 waves (the fourth persists for all later waves), cross-fading smoothly between tiers rather than snapping instantly.

### Combat

- Mouse-aim and click-to-fire on desktop; auto-aim at the nearest enemy with a dedicated shoot button and a virtual analog joystick for movement on mobile.
- Momentum-based movement, knockback impulses, screen shake, and brief hitstop freeze-frames on impactful kills.
- Every enemy type has multiple unique spawn and death lines, delivered as animated pixel speech bubbles paired with a pre-generated, pitch-shifted ElevenLabs voice line — the player has their own quip pools too (general kills, 10-kill streak milestones, tougher-enemy kills, and boss kills) — all funneled through a one-at-a-time voice queue so lines never overlap.
- Gunshots, hit/damage sounds, the game-over jingle, and the background music loop are all synthesized live via the Web Audio API — zero audio assets to ship or license for any of it, only the pre-generated dialogue voice lines are real files.
- Static cover obstacles block bullets and push entities around them.

## How to run it locally

### 1. Register your app on Blaze

Go to <https://dev.blaze.stream/applications/new> and create an application:

- **Application Name**: whatever you like, e.g. "Fire of the Blaze"
- **OAuth Redirect URL**: `http://localhost:3000/auth/callback` (click **Add**, then **Create Application**)

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

Open <http://localhost:3000>, click **Log in with Blaze**, approve access, and you'll land in the arena. Open your Blaze channel chat in another tab (or have someone chat while you stream) and type `!spawn`, `!heal`, `!shield`, or `!slow` to see it affect the game live.

## Known limitations (hackathon scope)

- Single active game session per login (no multiplayer arena).
- Leaderboard is a local JSON file on the server — fine for a demo, not for a real launch.
- Enemy voice audio is pre-generated per line (via `scripts/generate-voices.js`, run manually offline) rather than synthesized live.
- Requested OAuth scopes are kept minimal (`users.read`, `offline.access`) — the game only reads identity and chat activity, it doesn't post or moderate anything on your behalf.
