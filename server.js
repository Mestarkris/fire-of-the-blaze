require('dotenv').config();
const express = require('express');
const session = require('express-session');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const fetch = require('node-fetch');
const { Server } = require('socket.io');
const { io: ioClient } = require('socket.io-client');

const {
  BLAZE_CLIENT_ID,
  BLAZE_CLIENT_SECRET,
  BLAZE_REDIRECT_URI,
  SESSION_SECRET,
  PORT = 3000,
} = process.env;

if (!BLAZE_CLIENT_ID || !BLAZE_CLIENT_SECRET || !BLAZE_REDIRECT_URI) {
  console.error('Missing BLAZE_CLIENT_ID / BLAZE_CLIENT_SECRET / BLAZE_REDIRECT_URI in .env');
  console.error('Copy .env.example to .env and fill in your credentials from https://dev.blaze.stream/applications');
}

const BLAZE_AUTH_HOST = 'https://blaze.stream';
const BLAZE_API_HOST = 'https://api.blaze.stream';

const app = express();
const server = http.createServer(app);
const io = new Server(server); // socket.io server -> talks to OUR frontend

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const sessionMiddleware = session({
  secret: SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax' },
});
app.use(sessionMiddleware);

// Share the express session with socket.io connections so we know which
// browser socket belongs to which logged-in Blaze user.
io.engine.use(sessionMiddleware);

// ---------------------------------------------------------------------------
// Leaderboard persistence (simple JSON file - good enough for a hackathon demo)
// ---------------------------------------------------------------------------
const LEADERBOARD_FILE = path.join(__dirname, 'leaderboard.json');

function readLeaderboard() {
  try {
    return JSON.parse(fs.readFileSync(LEADERBOARD_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function writeLeaderboard(entries) {
  fs.writeFileSync(LEADERBOARD_FILE, JSON.stringify(entries, null, 2));
}

// One row per player - the board shows each player's best run, not a wall
// of one prolific player's attempts. Assumes the input is sorted desc.
function dedupeBoard(board) {
  const seen = new Set();
  const rows = [];
  for (const e of board) {
    if (seen.has(e.displayName)) continue;
    seen.add(e.displayName);
    rows.push(e);
  }
  return rows;
}

function submitScore(displayName, avatarUrl, score) {
  const board = readLeaderboard();
  board.push({ displayName, avatarUrl, score, at: new Date().toISOString() });
  board.sort((a, b) => b.score - a.score);
  writeLeaderboard(board.slice(0, 50));
  // Placement is the player's standing among players (dedeuped by best
  // run), so "you placed #3" means third-best player, not third-best run.
  const unique = dedupeBoard(board);
  const rank = unique.findIndex((e) => e.displayName === displayName) + 1;
  return { top10: unique.slice(0, 10), rank };
}

app.get('/api/leaderboard', (req, res) => {
  const board = readLeaderboard().sort((a, b) => b.score - a.score);
  res.json(dedupeBoard(board).slice(0, 10));
});

app.post('/api/leaderboard', (req, res) => {
  const { score } = req.body;
  if (!req.session.blaze) return res.status(401).json({ error: 'not logged in' });
  if (typeof score !== 'number') return res.status(400).json({ error: 'score required' });
  const { top10, rank } = submitScore(req.session.blaze.displayName, req.session.blaze.avatarUrl, score);
  res.json({ top10, rank });
});

// ---------------------------------------------------------------------------
// OAuth: User Access Token flow (Authorization Code + PKCE)
// docs: https://dev.blaze.stream/docs/oauth
// ---------------------------------------------------------------------------

app.get('/auth/login', async (req, res) => {
  try {
    const response = await fetch(`${BLAZE_AUTH_HOST}/bapi/oauth2/generate-auth-url`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        clientId: BLAZE_CLIENT_ID,
        clientSecret: BLAZE_CLIENT_SECRET,
        redirectUri: BLAZE_REDIRECT_URI,
        // Minimal scopes: read the user's identity and chat state.
        scopes: ['users.read', 'offline.access'],
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error('generate-auth-url failed', response.status, text);
      return res.status(500).send('Failed to start Blaze login. Check your .env credentials and redirect URL.');
    }

    const { url, state, codeVerifier } = await response.json();
    req.session.oauth = { state, codeVerifier };
    res.redirect(url);
  } catch (err) {
    console.error(err);
    res.status(500).send('Failed to reach Blaze OAuth endpoint.');
  }
});

app.get('/auth/callback', async (req, res) => {
  const { code, state } = req.query;
  const stored = req.session.oauth;

  if (!code) return res.status(400).send('Missing code from Blaze callback.');
  if (!stored || state !== stored.state) return res.status(400).send('State mismatch - possible CSRF, please try logging in again.');

  try {
    const tokenRes = await fetch(`${BLAZE_AUTH_HOST}/bapi/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        clientId: BLAZE_CLIENT_ID,
        clientSecret: BLAZE_CLIENT_SECRET,
        code,
        codeVerifier: stored.codeVerifier,
        redirectUri: BLAZE_REDIRECT_URI,
        grantType: 'authorization_code',
      }),
    });

    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      console.error('token exchange failed', tokenRes.status, text);
      return res.status(500).send('Failed to exchange code for a token.');
    }

    const token = await tokenRes.json(); // { accessToken, refreshToken, userId, expiresIn, scopes, ... }

    const profileRes = await fetch(`${BLAZE_API_HOST}/v1/users/profile`, {
      headers: {
        'client-id': BLAZE_CLIENT_ID,
        authorization: `Bearer ${token.accessToken}`,
        'content-type': 'application/json',
      },
    });
    const profileJson = await profileRes.json();
    const profile = profileJson.data;

    req.session.blaze = {
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      userId: profile.userId,
      // A user's own channel id matches their user id.
      channelId: profile.userId,
      username: profile.username,
      displayName: profile.displayName,
      avatarUrl: profile.avatarUrl,
    };
    delete req.session.oauth;

    res.redirect('/');
  } catch (err) {
    console.error(err);
    res.status(500).send('Login failed. See server logs for details.');
  }
});

app.get('/api/me', (req, res) => {
  if (!req.session.blaze) return res.json({ loggedIn: false });
  const { displayName, username, avatarUrl } = req.session.blaze;
  res.json({ loggedIn: true, displayName, username, avatarUrl });
});

app.post('/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// ---------------------------------------------------------------------------
// Blaze real-time events -> forwarded to the matching browser socket
// docs: https://dev.blaze.stream/docs/events
// ---------------------------------------------------------------------------

async function subscribeToChannelEvents(accessToken, channelId, sessionId) {
  const eventTypes = [
    'channel.chat.message',
    'channel.follow',
    'channel.subscribe',
    'channel.subscription.gift',
    'channel.vote',
    'channel.thanks', // on-chain tips - see https://dev.blaze.stream/docs/events/websocket-events
  ];

  for (const type of eventTypes) {
    try {
      const res = await fetch(`${BLAZE_API_HOST}/v1/events/subscriptions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'client-id': BLAZE_CLIENT_ID,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          type,
          version: '1',
          sessionId,
          condition: { channelId },
        }),
      });
      if (!res.ok) {
        console.warn(`Subscribe to ${type} failed:`, res.status, await res.text());
      }
    } catch (err) {
      console.warn(`Subscribe to ${type} errored:`, err.message);
    }
  }
}

function startBlazeSocketForSession(socket, blazeSession) {
  const blazeSocket = ioClient('https://blaze.stream', {
    path: '/ws',
    transports: ['websocket'],
    auth: { token: blazeSession.accessToken },
  });

  blazeSocket.on('eventsub', async (message) => {
    const { metadata, payload } = message || {};
    if (!metadata) return;

    if (metadata.messageType === 'session_welcome') {
      const blazeSessionId = payload.sessionId;
      await subscribeToChannelEvents(blazeSession.accessToken, blazeSession.channelId, blazeSessionId);
      socket.emit('blaze:ready');
      return;
    }

    if (metadata.messageType === 'notification') {
      // Forward straight to this browser session's game client.
      socket.emit('blaze:event', { type: metadata.subscriptionType, payload });
    }
  });

  blazeSocket.on('connect_error', (err) => {
    console.error('Blaze socket connect_error:', err.message);
    socket.emit('blaze:error', 'Could not connect to Blaze live events.');
  });

  socket.on('disconnect', () => {
    blazeSocket.disconnect();
  });

  return blazeSocket;
}

io.on('connection', (socket) => {
  const req = socket.request;
  const blazeSession = req.session && req.session.blaze;

  if (!blazeSession) {
    socket.emit('blaze:error', 'Not logged in with Blaze.');
    return;
  }

  socket.emit('blaze:profile', {
    displayName: blazeSession.displayName,
    username: blazeSession.username,
    avatarUrl: blazeSession.avatarUrl,
  });

  startBlazeSocketForSession(socket, blazeSession);
});

server.listen(PORT, () => {
  console.log(`Fire of the Blaze running at http://localhost:${PORT}`);
});
