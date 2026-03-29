// Copyright (c) 2025-2026 BlackRoad OS, Inc. All Rights Reserved.
// Proprietary and confidential. Unauthorized copying, distribution, or use is strictly prohibited.
// BlackRoad OS, Inc. — Delaware C-Corp — blackroad.io

// RoadView — WebRTC Video Conferencing & Screen Sharing
// Durable Object: VideoRoom — handles WebSocket signaling per room
// D1 binding: DB — room persistence

// ─── Durable Object: VideoRoom ───────────────────────────────────────────────
export class VideoRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map(); // peerId -> { ws, name, joinedAt }
    this.chatHistory = [];
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected WebSocket', { status: 426 });
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.handleSession(server, url.searchParams.get('name') || 'Guest');
      return new Response(null, { status: 101, webSocket: client });
    }
    if (url.pathname === '/info') {
      const participants = [];
      for (const [id, s] of this.sessions) {
        participants.push({ id, name: s.name, joinedAt: s.joinedAt });
      }
      return jsonResp({ participants, chatHistory: this.chatHistory.slice(-50) });
    }
    return new Response('Not found', { status: 404 });
  }

  handleSession(ws, name) {
    ws.accept();
    const peerId = crypto.randomUUID().slice(0, 12);
    this.sessions.set(peerId, { ws, name, joinedAt: new Date().toISOString() });

    // Tell this peer their ID and who's already here
    const existingPeers = [];
    for (const [id, s] of this.sessions) {
      if (id !== peerId) existingPeers.push({ id, name: s.name });
    }
    ws.send(JSON.stringify({ type: 'welcome', peerId, peers: existingPeers, chatHistory: this.chatHistory.slice(-50) }));

    // Tell everyone else about the new peer
    this.broadcast({ type: 'peer-joined', peerId, name }, peerId);

    ws.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }

      switch (msg.type) {
        case 'offer':
        case 'answer':
        case 'ice-candidate':
          // Forward signaling messages to the target peer
          const target = this.sessions.get(msg.targetPeerId);
          if (target && target.ws.readyState === 1) {
            target.ws.send(JSON.stringify({ ...msg, fromPeerId: peerId }));
          }
          break;
        case 'chat':
          const chatMsg = { name, text: (msg.text || '').slice(0, 2000), time: new Date().toISOString() };
          this.chatHistory.push(chatMsg);
          if (this.chatHistory.length > 200) this.chatHistory = this.chatHistory.slice(-100);
          this.broadcast({ type: 'chat', ...chatMsg }, null);
          break;
        case 'media-state':
          // Broadcast camera/mic/screen state changes
          this.broadcast({ type: 'media-state', peerId, camera: msg.camera, mic: msg.mic, screen: msg.screen, name }, peerId);
          break;
      }
    });

    ws.addEventListener('close', () => {
      this.sessions.delete(peerId);
      this.broadcast({ type: 'peer-left', peerId, name }, null);
    });

    ws.addEventListener('error', () => {
      this.sessions.delete(peerId);
      this.broadcast({ type: 'peer-left', peerId, name }, null);
    });
  }

  broadcast(msg, excludePeerId) {
    const data = JSON.stringify(msg);
    for (const [id, s] of this.sessions) {
      if (id !== excludePeerId && s.ws.readyState === 1) {
        try { s.ws.send(data); } catch {}
      }
    }
  }
}

// ─── Main Worker ─────────────────────────────────────────────────────────────
function addSecurityHeaders(response) {
  const h = new Headers(response.headers);
  h.set('X-Content-Type-Options', 'nosniff');
  
  h.set('X-XSS-Protection', '1; mode=block');
  h.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  h.delete('X-Frame-Options');
  h.set('Content-Security-Policy', "frame-ancestors 'self' https://blackroad.io https://*.blackroad.io");  h.set('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self)');
  return new Response(response.body, { status: response.status, headers: h });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    // Init D1 tables helper
    async function ensureTable() {
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS video_rooms (
        id TEXT PRIMARY KEY, name TEXT, created_by TEXT, created_at TEXT, last_active TEXT
      )`).run();
      // Migrate: add last_active if table was created before this column existed
      try {
        await env.DB.prepare(`ALTER TABLE video_rooms ADD COLUMN last_active TEXT`).run();
      } catch (_) { /* column already exists */ }
    }

    try {
      await ensureTable();
    } catch {}

    // ─── Health endpoint ─────────────────────────────────────────────────
    if (path === '/health') {
      return jsonResp({ status: 'ok', service: 'RoadView', version: '1.0.0' });
    }

    // ─── API Routes ────────────────────────────────────────────────────
    if (path === '/api/info') {
      return jsonResp({ name: 'RoadView', description: 'Video calls and streaming', version: '1.0.0', endpoints: ['/health', '/api/info', '/api/rooms'] });
    }

    if (path === '/api/health') {
      return jsonResp({ status: 'ok', service: 'roadview', version: '2.0.0', timestamp: new Date().toISOString() });
    }

    if (path === '/api/rooms' && request.method === 'GET') {
      try {
        await ensureTable();
        const { results } = await env.DB.prepare(
          'SELECT id, name, created_by, created_at, last_active FROM video_rooms ORDER BY last_active DESC LIMIT 50'
        ).all();
        return jsonResp({ rooms: results || [] });
      } catch (err) {
        return jsonResp({ rooms: [{ id: 'lobby', name: 'Lobby', active: 0 }] });
      }
    }

    if (path === '/api/rooms' && request.method === 'POST') {
      try {
        await ensureTable();
        const body = await request.json();
        const name = (body.name || 'Unnamed Room').slice(0, 100);
        const createdBy = (body.created_by || 'anonymous').slice(0, 50);
        const id = crypto.randomUUID().slice(0, 8);
        const now = new Date().toISOString();
        await env.DB.prepare(
          'INSERT INTO video_rooms (id, name, created_by, created_at, last_active) VALUES (?, ?, ?, ?, ?)'
        ).bind(id, name, createdBy, now, now).run();
        return jsonResp({ id, name, created_by: createdBy, share_url: `${url.origin}/room/${id}` }, 201);
      } catch (err) {
        return jsonResp({ error: 'Failed to create room', detail: err.message }, 500);
      }
    }

    // ─── WebSocket signaling via Durable Object ──────────────────────
    const wsMatch = path.match(/^\/ws\/([a-z0-9-]+)$/);
    if (wsMatch) {
      const roomId = wsMatch[1];
      // Touch last_active
      try {
        await env.DB.prepare('UPDATE video_rooms SET last_active = ? WHERE id = ?')
          .bind(new Date().toISOString(), roomId).run();
      } catch {}
      const doId = env.ROOM.idFromName(roomId);
      const stub = env.ROOM.get(doId);
      const wsUrl = new URL(request.url);
      wsUrl.pathname = '/ws';
      return stub.fetch(new Request(wsUrl.toString(), request));
    }

    // ─── Room info via Durable Object ────────────────────────────────
    const roomInfoMatch = path.match(/^\/api\/rooms\/([a-z0-9-]+)$/);
    if (roomInfoMatch) {
      const roomId = roomInfoMatch[1];
      const room = await env.DB.prepare('SELECT * FROM video_rooms WHERE id = ?').bind(roomId).first();
      if (!room) return jsonResp({ error: 'Room not found' }, 404);
      // Get live participant info from DO
      const doId = env.ROOM.idFromName(roomId);
      const stub = env.ROOM.get(doId);
      const infoUrl = new URL(request.url);
      infoUrl.pathname = '/info';
      const infoRes = await stub.fetch(new Request(infoUrl.toString()));
      const info = await infoRes.json();
      return jsonResp({ ...room, ...info });
    }

    // ─── /api/videos alias for /api/rooms ─────────────────────────────
    if (path === '/api/videos' && request.method === 'GET') {
      try {
        const { results } = await env.DB.prepare(
          'SELECT id, name, created_by, created_at, last_active FROM video_rooms ORDER BY last_active DESC LIMIT 50'
        ).all();
        return jsonResp({ videos: results || [] });
      } catch (err) {
        return jsonResp({ videos: [] });
      }
    }

    // ─── Catch-all for unmatched API paths ────────────────────────────
    if (path.startsWith('/api/')) {
      return jsonResp({ error: 'not found' }, 404);
    }

    // ─── Serve HTML for everything else ──────────────────────────────
    return addSecurityHeaders(new Response(HTML, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    }));
  },
};

function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

// ─── Full Application HTML ───────────────────────────────────────────────────
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='6' fill='%230a0a0a'/><circle cx='10' cy='16' r='5' fill='%23FF2255'/><rect x='18' y='11' width='10' height='10' rx='2' fill='%238844FF'/></svg>" type="image/svg+xml">
<title>RoadView -- Video Conferencing | BlackRoad</title>
<meta name="description" content="RoadView: WebRTC video conferencing, screen sharing, and real-time chat. No sign-up required. By BlackRoad OS.">
<meta property="og:title" content="RoadView -- Video Conferencing | BlackRoad OS">
<meta property="og:description" content="WebRTC video conferencing, screen sharing, and real-time chat. No sign-up required.">
<meta property="og:url" content="https://video.blackroad.io">
<meta property="og:type" content="website">
<meta property="og:image" content="https://images.blackroad.io/pixel-art/road-logo.png">
<meta name="twitter:card" content="summary">
<link rel="canonical" href="https://video.blackroad.io/">
<meta name="robots" content="index, follow">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebApplication","name":"RoadView","url":"https://video.blackroad.io","applicationCategory":"CommunicationApplication","operatingSystem":"Web","description":"WebRTC video conferencing with screen sharing","author":{"@type":"Organization","name":"BlackRoad OS, Inc."}}</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Inter:wght@400;500&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
:root {
  --bg: #0a0a0a;
  --bg-card: #111111;
  --bg-input: #141414;
  --border: #1a1a1a;
  --border-hover: #333;
  --text: #e5e5e5;
  --text-dim: #a3a3a3;
  --text-muted: #525252;
  --pink: #FF1D6C;
  --amber: #F5A623;
  --blue: #2979FF;
  --violet: #9C27B0;
  --green: #4caf50;
  --red: #e53935;
  --font-heading: 'Space Grotesk', -apple-system, sans-serif;
  --font-body: 'Inter', -apple-system, sans-serif;
  --font-mono: 'JetBrains Mono', monospace;
}
*, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
body {
  background: var(--bg);
  color: var(--text);
  font-family: var(--font-body);
  height: 100vh;
  overflow: hidden;
}
h1, h2, h3 { font-family: var(--font-heading); font-weight: 600; color: var(--text); }
code, .mono { font-family: var(--font-mono); }

button {
  font-family: var(--font-heading);
  background: var(--bg-card);
  color: var(--text-dim);
  border: 1px solid var(--border);
  padding: 8px 16px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 0.85rem;
  font-weight: 500;
  transition: all 0.15s ease;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
button:hover { border-color: var(--border-hover); color: var(--text); }
button.primary { background: var(--blue); border-color: var(--blue); color: #fff; }
button.primary:hover { background: #1565C0; }
button.active { border-color: var(--green); color: var(--green); }
button.danger { border-color: var(--red); color: var(--red); }
button.danger:hover { background: var(--red); color: #fff; }
button.off { border-color: var(--red); color: var(--red); opacity: 0.8; }

input {
  font-family: var(--font-body);
  background: var(--bg-input);
  border: 1px solid var(--border);
  color: var(--text);
  padding: 12px 16px;
  border-radius: 8px;
  font-size: 0.95rem;
  outline: none;
  transition: border-color 0.15s;
}
input:focus { border-color: var(--border-hover); }
input::placeholder { color: var(--text-muted); }

/* ─── Lobby ───────────────────────────────────────────────────── */
.lobby {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
  min-height: 100vh;
  gap: 16px;
  padding: 60px 20px 40px;
  overflow-y: auto;
}
.lobby-brand {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 4px;
}
.lobby-brand .mark {
  display: flex;
  gap: 5px;
}
.lobby-brand .mark span {
  width: 12px;
  height: 12px;
  border-radius: 50%;
}
.lobby h1 { font-size: 2rem; letter-spacing: -0.03em; }
.lobby .subtitle { color: var(--text-dim); font-size: 0.9rem; text-align: center; max-width: 480px; line-height: 1.6; }
.lobby-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 100%;
  max-width: 400px;
  margin-top: 8px;
}
.lobby-form input { width: 100%; text-align: center; }
.lobby-divider {
  color: var(--text-muted);
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 1.5px;
  margin: 12px 0 4px;
  text-align: center;
  font-family: var(--font-mono);
}
.room-list {
  width: 100%;
  max-width: 400px;
  margin-top: 4px;
}
.room-list h3 {
  color: var(--text-muted);
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 1.5px;
  margin-bottom: 10px;
  font-family: var(--font-mono);
}
.room-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 10px;
  margin-bottom: 8px;
  transition: border-color 0.15s;
}
.room-item:hover { border-color: var(--border-hover); }
.room-item .rname { color: var(--text-dim); font-size: 0.9rem; font-family: var(--font-heading); font-weight: 500; }
.room-item .rcreator { color: var(--text-muted); font-size: 0.75rem; font-family: var(--font-mono); margin-top: 2px; }
.room-item .rright { display: flex; align-items: center; gap: 10px; }
.room-item .rcount {
  font-family: var(--font-mono);
  color: var(--text-muted);
  font-size: 0.75rem;
}
.room-item .join-btn {
  padding: 6px 16px;
  font-size: 0.8rem;
  border-radius: 6px;
}
.room-item .share-btn {
  padding: 6px 10px;
  font-size: 0.75rem;
  border-radius: 6px;
  color: var(--text-muted);
}
.room-item .share-btn:hover { color: var(--text-dim); }
.lobby-footer {
  margin-top: 24px;
  color: var(--text-muted);
  font-size: 0.7rem;
  letter-spacing: 0.5px;
  font-family: var(--font-mono);
}

/* ─── Top Bar ─────────────────────────────────────────────────── */
.top-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
  flex-wrap: wrap;
}
.top-bar .brand-marks {
  display: flex;
  gap: 3px;
}
.top-bar .brand-marks span {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.top-bar h1 { font-size: 1.1rem; letter-spacing: -0.01em; }
.top-bar .room-name {
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 0.8rem;
}
.top-bar .controls {
  margin-left: auto;
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  align-items: center;
}

/* ─── Circle Buttons (media controls) ─────────────────────────── */
.ctrl-circle {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  border: 1px solid var(--border);
  background: var(--bg-card);
  color: var(--text-dim);
  font-size: 0.7rem;
  font-family: var(--font-mono);
  font-weight: 500;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s;
  padding: 0;
}
.ctrl-circle:hover { border-color: var(--border-hover); color: var(--text); }
.ctrl-circle.on { border-color: var(--green); color: var(--green); }
.ctrl-circle.off-state { border-color: var(--red); color: var(--red); }
.ctrl-circle.screen-on { border-color: var(--blue); color: var(--blue); }
.ctrl-circle.leave { border-color: var(--red); color: var(--red); }
.ctrl-circle.leave:hover { background: var(--red); color: #fff; }

/* ─── Main Layout ─────────────────────────────────────────────── */
.main {
  display: flex;
  height: calc(100vh - 53px);
}
.video-area {
  flex: 1;
  display: flex;
  flex-direction: column;
  padding: 10px;
  gap: 10px;
  min-width: 0;
}

/* ─── Video Grid ──────────────────────────────────────────────── */
.video-grid {
  flex: 1;
  display: grid;
  gap: 8px;
  grid-template-columns: 1fr;
  grid-auto-rows: 1fr;
}
.video-grid.g2 { grid-template-columns: 1fr 1fr; }
.video-grid.g3, .video-grid.g4 { grid-template-columns: 1fr 1fr; }
.video-grid.g5, .video-grid.g6 { grid-template-columns: 1fr 1fr 1fr; }
.video-grid.g7, .video-grid.g8, .video-grid.g9 { grid-template-columns: 1fr 1fr 1fr; }

.video-cell {
  background: var(--bg-card);
  border-radius: 12px;
  position: relative;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border);
  min-height: 140px;
}
.video-cell video {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 12px;
}
.video-cell .label {
  position: absolute;
  bottom: 10px;
  left: 10px;
  background: rgba(10,10,10,0.85);
  color: var(--text-dim);
  padding: 4px 12px;
  border-radius: 6px;
  font-size: 0.75rem;
  font-family: var(--font-mono);
  backdrop-filter: blur(6px);
}
.video-cell .media-icons {
  position: absolute;
  top: 10px;
  right: 10px;
  display: flex;
  gap: 4px;
}
.video-cell .media-icons span {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.6rem;
  font-family: var(--font-mono);
  background: rgba(10,10,10,0.75);
  color: var(--text-dim);
  backdrop-filter: blur(6px);
}
.video-cell .media-icons span.off { color: var(--red); }
.video-cell .avatar {
  width: 72px;
  height: 72px;
  border-radius: 50%;
  background: var(--border);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1.6rem;
  color: var(--text-dim);
  font-family: var(--font-heading);
  font-weight: 600;
}

/* ─── Sidebar / Chat ──────────────────────────────────────────── */
.sidebar {
  width: 340px;
  background: var(--bg);
  border-left: 1px solid var(--border);
  display: flex;
  flex-direction: column;
}
.sidebar.hidden { display: none; }
.sidebar-tabs {
  display: flex;
  border-bottom: 1px solid var(--border);
}
.sidebar-tabs button {
  flex: 1;
  border: none;
  border-radius: 0;
  padding: 12px;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 1.5px;
  background: transparent;
  font-family: var(--font-mono);
}
.sidebar-tabs button.active {
  color: var(--text);
  box-shadow: inset 0 -2px 0 var(--blue);
}
.tab-content { flex: 1; overflow-y: auto; display: none; }
.tab-content.active { display: flex; flex-direction: column; }

.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 14px 16px;
}
.chat-msg { margin-bottom: 14px; }
.chat-msg .msg-name {
  font-size: 0.7rem;
  font-weight: 600;
  color: var(--text-dim);
  margin-bottom: 3px;
  font-family: var(--font-mono);
}
.chat-msg .msg-name.system { color: var(--text-muted); }
.chat-msg .msg-text {
  font-size: 0.85rem;
  color: var(--text-dim);
  line-height: 1.5;
  word-break: break-word;
}
.chat-msg .msg-time {
  font-size: 0.6rem;
  color: var(--text-muted);
  margin-top: 3px;
  font-family: var(--font-mono);
}
.chat-input {
  display: flex;
  gap: 6px;
  padding: 12px 14px;
  border-top: 1px solid var(--border);
}
.chat-input input {
  flex: 1;
  padding: 10px 14px;
  font-size: 0.85rem;
}
.chat-input button { padding: 10px 16px; }

.participants-list { padding: 14px 16px; }
.participant-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 0;
  border-bottom: 1px solid var(--border);
}
.participant-item:last-child { border-bottom: none; }
.participant-item .p-avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--border);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.85rem;
  color: var(--text-dim);
  font-weight: 600;
  font-family: var(--font-heading);
}
.participant-item .p-name { color: var(--text-dim); font-size: 0.85rem; }
.participant-item .p-you {
  font-family: var(--font-mono);
  color: var(--text-muted);
  font-size: 0.65rem;
  text-transform: uppercase;
  letter-spacing: 1px;
}
.participant-item .p-icons {
  margin-left: auto;
  display: flex;
  gap: 6px;
  font-size: 0.7rem;
  font-family: var(--font-mono);
  color: var(--text-muted);
}
.participant-item .p-icons span.on { color: var(--green); }
.participant-item .p-icons span.off { color: var(--red); }

/* ─── Status Bar ──────────────────────────────────────────────── */
.status-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  font-size: 0.72rem;
  color: var(--text-muted);
  border-top: 1px solid var(--border);
  font-family: var(--font-mono);
}
.status-bar .dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--green);
}
.status-bar .dot.disconnected { background: var(--red); }

/* ─── Toast ───────────────────────────────────────────────────── */
.toast {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  background: var(--bg-card);
  border: 1px solid var(--border);
  color: var(--text-dim);
  padding: 12px 24px;
  border-radius: 10px;
  font-size: 0.85rem;
  font-family: var(--font-mono);
  opacity: 0;
  transition: opacity 0.3s;
  pointer-events: none;
  z-index: 100;
}
.toast.show { opacity: 1; }

/* ─── Responsive ──────────────────────────────────────────────── */
@media (max-width: 768px) {
  .sidebar { position: fixed; right: 0; top: 53px; bottom: 0; width: 100%; z-index: 10; }
  .top-bar .controls { gap: 4px; }
  .ctrl-circle { width: 36px; height: 36px; font-size: 0.6rem; }
  .video-grid.g2, .video-grid.g3, .video-grid.g4 { grid-template-columns: 1fr; }
  .lobby { padding: 40px 16px 20px; }
}

::-webkit-scrollbar { width: 4px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
</style>
</head>
<body>
<style id="br-nav-style">#br-nav{position:fixed;top:0;left:0;right:0;z-index:9999;background:rgba(10,10,10,0.92);backdrop-filter:blur(12px);border-bottom:1px solid #1a1a1a;font-family:'Space Grotesk',-apple-system,sans-serif}#br-nav .ni{max-width:1200px;margin:0 auto;padding:0 20px;height:48px;display:flex;align-items:center;justify-content:space-between}#br-nav .nl{display:flex;align-items:center;gap:12px}#br-nav .nb{color:#525252;font-size:12px;padding:6px 8px;border-radius:6px;display:flex;align-items:center;cursor:pointer;border:none;background:none;transition:color .15s}#br-nav .nb:hover{color:#e5e5e5}#br-nav .nh{text-decoration:none;display:flex;align-items:center;gap:8px}#br-nav .nm{display:flex;gap:2px}#br-nav .nm span{width:6px;height:6px;border-radius:50%}#br-nav .nt{color:#e5e5e5;font-weight:600;font-size:14px}#br-nav .ns{color:#333;font-size:14px}#br-nav .np{color:#a3a3a3;font-size:13px}#br-nav .nk{display:flex;align-items:center;gap:4px;overflow-x:auto;scrollbar-width:none}#br-nav .nk::-webkit-scrollbar{display:none}#br-nav .nk a{color:#525252;text-decoration:none;font-size:12px;padding:6px 10px;border-radius:6px;white-space:nowrap;transition:color .15s,background .15s}#br-nav .nk a:hover{color:#e5e5e5;background:#111}#br-nav .nk a.ac{color:#e5e5e5;background:#1a1a1a}#br-nav .mm{display:none;background:none;border:none;color:#525252;font-size:20px;cursor:pointer;padding:6px}#br-dd{display:none;position:fixed;top:48px;left:0;right:0;background:rgba(10,10,10,0.96);backdrop-filter:blur(12px);border-bottom:1px solid #1a1a1a;z-index:9998;padding:12px 20px}#br-dd.open{display:flex;flex-wrap:wrap;gap:4px}#br-dd a{color:#525252;text-decoration:none;font-size:13px;padding:8px 14px;border-radius:6px;transition:color .15s,background .15s}#br-dd a:hover,#br-dd a.ac{color:#e5e5e5;background:#111}body{padding-top:48px!important}@media(max-width:768px){#br-nav .nk{display:none}#br-nav .mm{display:block}}</style>
<nav id="br-nav"><div class="ni"><div class="nl"><button class="nb" onclick="history.length>1?history.back():location.href='https://blackroad.io'" title="Back">&larr;</button><a href="https://blackroad.io" class="nh"><div class="nm"><span style="background:#FF6B2B"></span><span style="background:#FF2255"></span><span style="background:#CC00AA"></span><span style="background:#8844FF"></span><span style="background:#4488FF"></span><span style="background:#00D4FF"></span></div><span class="nt">BlackRoad</span></a><span class="ns">/</span><span class="np">Video</span></div><div class="nk"><a href="https://blackroad.io">Home</a><a href="https://chat.blackroad.io">Chat</a><a href="https://search.blackroad.io">Search</a><a href="https://tutor.blackroad.io">Tutor</a><a href="https://pay.blackroad.io">Pay</a><a href="https://canvas.blackroad.io">Canvas</a><a href="https://cadence.blackroad.io">Cadence</a><a href="https://video.blackroad.io" class="ac">Video</a><a href="https://radio.blackroad.io">Radio</a><a href="https://game.blackroad.io">Game</a><a href="https://roadtrip.blackroad.io">Agents</a><a href="https://roadcode.blackroad.io">RoadCode</a><a href="https://hq.blackroad.io">HQ</a><a href="https://app.blackroad.io">Dashboard</a></div><button class="mm" onclick="document.getElementById('br-dd').classList.toggle('open')">&#9776;</button></div></nav><div id="br-dd"><a href="https://blackroad.io">Home</a><a href="https://chat.blackroad.io">Chat</a><a href="https://search.blackroad.io">Search</a><a href="https://tutor.blackroad.io">Tutor</a><a href="https://pay.blackroad.io">Pay</a><a href="https://canvas.blackroad.io">Canvas</a><a href="https://cadence.blackroad.io">Cadence</a><a href="https://video.blackroad.io" class="ac">Video</a><a href="https://radio.blackroad.io">Radio</a><a href="https://game.blackroad.io">Game</a><a href="https://roadtrip.blackroad.io">Agents</a><a href="https://roadcode.blackroad.io">RoadCode</a><a href="https://hq.blackroad.io">HQ</a><a href="https://app.blackroad.io">Dashboard</a></div>
<script>document.addEventListener('click',function(e){var d=document.getElementById('br-dd');if(d&&d.classList.contains('open')&&!e.target.closest('#br-nav')&&!e.target.closest('#br-dd'))d.classList.remove('open')});</script>

<!-- ─── Lobby ──────────────────────────────────────────────────── -->
<div id="lobby" class="lobby">
  <div class="lobby-brand">
    <div class="mark">
      <span style="background:#FF1D6C"></span>
      <span style="background:#F5A623"></span>
      <span style="background:#2979FF"></span>
      <span style="background:#9C27B0"></span>
    </div>
    <h1>RoadView</h1>
  </div>
  <p class="subtitle">Video conferencing, screen sharing, and real-time chat. Peer-to-peer encrypted via WebRTC. No sign-up required.</p>

  <div class="lobby-form">
    <input id="userName" placeholder="Your name" maxlength="50" autocomplete="off">
    <input id="roomName" placeholder="Room name" maxlength="100" autocomplete="off">
    <button class="primary" onclick="createRoom()" style="width:100%;justify-content:center;padding:14px;font-size:0.95rem">Create Room</button>
  </div>

  <div class="lobby-divider">or join an existing room</div>
  <div class="room-list" id="roomList"></div>

  <div class="lobby-footer">BlackRoad OS, Inc. -- video.blackroad.io</div>
</div>

<!-- ─── App ────────────────────────────────────────────────────── -->
<div id="app" style="display:none">
  <div class="top-bar">
    <div class="brand-marks">
      <span style="background:#FF1D6C"></span>
      <span style="background:#F5A623"></span>
      <span style="background:#2979FF"></span>
      <span style="background:#9C27B0"></span>
    </div>
    <h1>RoadView</h1>
    <span class="room-name" id="roomTitle"></span>
    <div class="controls">
      <button class="ctrl-circle off-state" onclick="toggleMic()" id="btnMic" title="Toggle microphone">MIC</button>
      <button class="ctrl-circle off-state" onclick="toggleCamera()" id="btnCam" title="Toggle camera">CAM</button>
      <button class="ctrl-circle" onclick="toggleScreen()" id="btnScreen" title="Share screen">SCR</button>
      <button class="ctrl-circle" onclick="toggleChat()" id="btnChat" title="Toggle chat">CHT</button>
      <button class="ctrl-circle" onclick="copyLink()" title="Copy invite link">URL</button>
      <button class="ctrl-circle leave" onclick="leaveRoom()" title="Leave room">END</button>
    </div>
  </div>
  <div class="main">
    <div class="video-area">
      <div class="video-grid" id="videoGrid"></div>
      <div class="status-bar">
        <div class="dot" id="connDot"></div>
        <span id="connStatus">Connecting...</span>
        <span style="margin-left:auto" id="peerCount">0 participants</span>
      </div>
    </div>
    <div class="sidebar" id="chatSidebar">
      <div class="sidebar-tabs">
        <button class="active" onclick="switchTab('chat',this)">Chat</button>
        <button onclick="switchTab('participants',this)">People</button>
      </div>
      <div class="tab-content active" id="tabChat">
        <div class="chat-messages" id="chatMessages"></div>
        <div class="chat-input">
          <input id="chatInput" placeholder="Type a message..." maxlength="2000" onkeydown="if(event.key==='Enter')sendChat()">
          <button onclick="sendChat()">Send</button>
        </div>
      </div>
      <div class="tab-content" id="tabParticipants">
        <div class="participants-list" id="participantsList"></div>
      </div>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
const S = {
  roomId: null,
  userName: '',
  peerId: null,
  ws: null,
  localStream: null,
  screenStream: null,
  peers: {},
  cameraOn: false,
  micOn: false,
  screenOn: false,
  chatOpen: true,
};

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
];

const pathRoom = location.pathname.match(/^\\/room\\/([a-z0-9-]+)/);
if (pathRoom) S.roomId = pathRoom[1];

async function loadRooms() {
  try {
    const res = await fetch('/api/rooms');
    const data = await res.json();
    const el = document.getElementById('roomList');
    if (!data.rooms || data.rooms.length === 0) {
      el.innerHTML = '<p style="color:var(--text-muted);font-size:.8rem;text-align:center;font-family:var(--font-mono)">No active rooms</p>';
      return;
    }
    el.innerHTML = '<h3>Active Rooms</h3>' + data.rooms.slice(0, 10).map(r =>
      '<div class="room-item">' +
        '<div><div class="rname">' + esc(r.name) + '</div><div class="rcreator">' + esc(r.created_by || '') + ' -- ' + timeAgo(r.last_active) + '</div></div>' +
        '<div class="rright">' +
          '<button class="share-btn" onclick="event.stopPropagation();copyRoomLink(\\'' + esc(r.id) + '\\')" title="Copy link">LINK</button>' +
          '<button class="join-btn primary" onclick="joinRoom(\\'' + esc(r.id) + '\\')">Join</button>' +
        '</div>' +
      '</div>'
    ).join('');
  } catch(e) { console.log('Could not load rooms', e); }
}

function copyRoomLink(id) {
  navigator.clipboard.writeText(location.origin + '/room/' + id).then(() => showToast('Room link copied'));
}

async function createRoom() {
  S.userName = document.getElementById('userName').value.trim() || 'Guest';
  const name = document.getElementById('roomName').value.trim() || S.userName + "'s Room";
  try {
    const res = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, created_by: S.userName })
    });
    const data = await res.json();
    S.roomId = data.id;
    history.pushState(null, '', '/room/' + data.id);
    enterRoom();
  } catch(e) { showToast('Failed to create room'); }
}

function joinRoom(id) {
  S.userName = document.getElementById('userName').value.trim() || 'Guest';
  S.roomId = id;
  history.pushState(null, '', '/room/' + id);
  enterRoom();
}

function enterRoom() {
  document.getElementById('lobby').style.display = 'none';
  document.getElementById('app').style.display = '';
  document.getElementById('roomTitle').textContent = S.roomId;
  rebuildGrid();
  connectSignaling();
  addSystemMsg('Joined room. Share the invite link to connect with others.');
}

function connectSignaling() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = proto + '//' + location.host + '/ws/' + S.roomId + '?name=' + encodeURIComponent(S.userName);
  S.ws = new WebSocket(wsUrl);
  S.ws.onopen = () => {
    document.getElementById('connDot').className = 'dot';
    document.getElementById('connStatus').textContent = 'Connected';
  };
  S.ws.onclose = () => {
    document.getElementById('connDot').className = 'dot disconnected';
    document.getElementById('connStatus').textContent = 'Disconnected';
    setTimeout(() => { if (S.roomId) connectSignaling(); }, 3000);
  };
  S.ws.onerror = () => {
    document.getElementById('connDot').className = 'dot disconnected';
    document.getElementById('connStatus').textContent = 'Connection error';
  };
  S.ws.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    handleSignalingMessage(msg);
  };
}

async function handleSignalingMessage(msg) {
  switch (msg.type) {
    case 'welcome':
      S.peerId = msg.peerId;
      if (msg.chatHistory) msg.chatHistory.forEach(m => addChatMsg(m.name, m.text, m.time));
      for (const peer of msg.peers) await createPeerConnection(peer.id, peer.name, true);
      updateParticipants();
      break;
    case 'peer-joined':
      addSystemMsg(msg.name + ' joined the room');
      await createPeerConnection(msg.peerId, msg.name, false);
      updateParticipants();
      break;
    case 'peer-left':
      addSystemMsg(msg.name + ' left the room');
      removePeer(msg.peerId);
      updateParticipants();
      break;
    case 'offer': await handleOffer(msg); break;
    case 'answer': await handleAnswer(msg); break;
    case 'ice-candidate': await handleIceCandidate(msg); break;
    case 'chat': addChatMsg(msg.name, msg.text, msg.time); break;
    case 'media-state':
      if (S.peers[msg.peerId]) {
        S.peers[msg.peerId].camera = msg.camera;
        S.peers[msg.peerId].mic = msg.mic;
        S.peers[msg.peerId].screen = msg.screen;
        updateParticipants();
        rebuildGrid();
      }
      break;
  }
}

async function createPeerConnection(remotePeerId, remoteName, isInitiator) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  S.peers[remotePeerId] = { pc, name: remoteName, camera: false, mic: false, screen: false };
  if (S.localStream) S.localStream.getTracks().forEach(track => pc.addTrack(track, S.localStream));
  if (S.screenStream) S.screenStream.getTracks().forEach(track => pc.addTrack(track, S.screenStream));
  pc.ontrack = (event) => {
    const stream = event.streams[0];
    if (!S.peers[remotePeerId]) return;
    S.peers[remotePeerId].stream = stream;
    rebuildGrid();
  };
  pc.onicecandidate = (event) => {
    if (event.candidate && S.ws && S.ws.readyState === 1)
      S.ws.send(JSON.stringify({ type: 'ice-candidate', targetPeerId: remotePeerId, candidate: event.candidate }));
  };
  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') removePeer(remotePeerId);
  };
  if (isInitiator) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    if (S.ws && S.ws.readyState === 1)
      S.ws.send(JSON.stringify({ type: 'offer', targetPeerId: remotePeerId, sdp: pc.localDescription }));
  }
  rebuildGrid();
  return pc;
}

async function handleOffer(msg) {
  let peer = S.peers[msg.fromPeerId];
  if (!peer) { await createPeerConnection(msg.fromPeerId, 'Peer', false); peer = S.peers[msg.fromPeerId]; }
  await peer.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
  const answer = await peer.pc.createAnswer();
  await peer.pc.setLocalDescription(answer);
  if (S.ws && S.ws.readyState === 1)
    S.ws.send(JSON.stringify({ type: 'answer', targetPeerId: msg.fromPeerId, sdp: peer.pc.localDescription }));
}

async function handleAnswer(msg) {
  const peer = S.peers[msg.fromPeerId];
  if (peer) await peer.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
}

async function handleIceCandidate(msg) {
  const peer = S.peers[msg.fromPeerId];
  if (peer && msg.candidate) try { await peer.pc.addIceCandidate(new RTCIceCandidate(msg.candidate)); } catch {}
}

function removePeer(peerId) {
  const peer = S.peers[peerId];
  if (peer) { try { peer.pc.close(); } catch {} delete S.peers[peerId]; rebuildGrid(); updateParticipants(); }
}

function sendTracksToAllPeers(stream) {
  for (const [pid, peer] of Object.entries(S.peers)) {
    const senders = peer.pc.getSenders();
    stream.getTracks().forEach(track => {
      const existing = senders.find(s => s.track && s.track.kind === track.kind);
      if (existing) existing.replaceTrack(track); else peer.pc.addTrack(track, stream);
    });
    renegotiate(peer.pc, pid);
  }
}

async function renegotiate(pc, targetPeerId) {
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify({ type: 'offer', targetPeerId, sdp: pc.localDescription }));
  } catch {}
}

function broadcastMediaState() {
  if (S.ws && S.ws.readyState === 1)
    S.ws.send(JSON.stringify({ type: 'media-state', camera: S.cameraOn, mic: S.micOn, screen: S.screenOn }));
}

async function toggleCamera() {
  if (S.cameraOn && S.localStream) {
    S.localStream.getVideoTracks().forEach(t => t.stop());
    S.localStream.getAudioTracks().forEach(t => t.stop());
    S.localStream = null; S.cameraOn = false; S.micOn = false;
    updateButtons(); broadcastMediaState(); rebuildGrid(); return;
  }
  try {
    S.localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    S.cameraOn = true; S.micOn = true;
    sendTracksToAllPeers(S.localStream); updateButtons(); broadcastMediaState(); rebuildGrid();
  } catch(e) { addSystemMsg('Camera access denied: ' + e.message); }
}

async function toggleMic() {
  if (!S.localStream) {
    try {
      S.localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      S.micOn = true; sendTracksToAllPeers(S.localStream); updateButtons(); broadcastMediaState(); rebuildGrid();
    } catch(e) { addSystemMsg('Microphone access denied: ' + e.message); }
    return;
  }
  S.micOn = !S.micOn;
  S.localStream.getAudioTracks().forEach(t => { t.enabled = S.micOn; });
  updateButtons(); broadcastMediaState();
}

async function toggleScreen() {
  if (S.screenOn && S.screenStream) {
    S.screenStream.getTracks().forEach(t => t.stop());
    S.screenStream = null; S.screenOn = false;
    updateButtons(); broadcastMediaState(); rebuildGrid(); return;
  }
  try {
    S.screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    S.screenOn = true; sendTracksToAllPeers(S.screenStream);
    S.screenStream.getVideoTracks()[0].onended = () => {
      S.screenStream = null; S.screenOn = false; updateButtons(); broadcastMediaState(); rebuildGrid();
    };
    updateButtons(); broadcastMediaState(); rebuildGrid();
  } catch(e) { addSystemMsg('Screen share cancelled'); }
}

function updateButtons() {
  const btnCam = document.getElementById('btnCam');
  const btnMic = document.getElementById('btnMic');
  const btnScreen = document.getElementById('btnScreen');
  btnCam.textContent = S.cameraOn ? 'CAM' : 'CAM';
  btnCam.className = 'ctrl-circle ' + (S.cameraOn ? 'on' : 'off-state');
  btnMic.textContent = S.micOn ? 'MIC' : 'MIC';
  btnMic.className = 'ctrl-circle ' + (S.micOn ? 'on' : 'off-state');
  btnScreen.textContent = S.screenOn ? 'SCR' : 'SCR';
  btnScreen.className = 'ctrl-circle ' + (S.screenOn ? 'screen-on' : '');
}

function rebuildGrid() {
  const grid = document.getElementById('videoGrid');
  grid.innerHTML = '';
  const cells = [];
  cells.push(buildVideoCell('local-cam', S.userName + ' (You)', S.localStream, true));
  if (S.screenStream) cells.push(buildVideoCell('local-screen', 'Your Screen', S.screenStream, false));
  for (const [pid, peer] of Object.entries(S.peers)) {
    if (peer.stream) cells.push(buildVideoCell('remote-' + pid, peer.name, peer.stream, false));
    else cells.push(buildAvatarCell(peer.name));
  }
  const count = cells.length;
  grid.className = 'video-grid' + (count >= 7 ? ' g9' : count >= 5 ? ' g6' : count >= 3 ? ' g4' : count >= 2 ? ' g2' : '');
  cells.forEach(cell => grid.appendChild(cell));
  const total = 1 + Object.keys(S.peers).length;
  document.getElementById('peerCount').textContent = total + ' participant' + (total !== 1 ? 's' : '');
}

function buildVideoCell(id, label, stream, muted) {
  const cell = document.createElement('div');
  cell.className = 'video-cell'; cell.id = 'cell-' + id;
  if (stream && stream.getVideoTracks().length > 0) {
    const video = document.createElement('video');
    video.autoplay = true; video.playsInline = true;
    if (muted) video.muted = true;
    video.srcObject = stream; cell.appendChild(video);
  } else {
    const avatar = document.createElement('div');
    avatar.className = 'avatar'; avatar.textContent = (label || '?')[0].toUpperCase();
    cell.appendChild(avatar);
  }
  const lbl = document.createElement('div');
  lbl.className = 'label'; lbl.textContent = label;
  cell.appendChild(lbl);
  return cell;
}

function buildAvatarCell(name) {
  const cell = document.createElement('div'); cell.className = 'video-cell';
  const avatar = document.createElement('div'); avatar.className = 'avatar';
  avatar.textContent = (name || '?')[0].toUpperCase(); cell.appendChild(avatar);
  const lbl = document.createElement('div'); lbl.className = 'label';
  lbl.textContent = name; cell.appendChild(lbl);
  return cell;
}

function sendChat() {
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  if (!text || !S.ws || S.ws.readyState !== 1) return;
  S.ws.send(JSON.stringify({ type: 'chat', text })); input.value = '';
}

function addChatMsg(name, text, time) {
  const el = document.getElementById('chatMessages');
  const div = document.createElement('div'); div.className = 'chat-msg';
  const t = time ? new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  div.innerHTML = '<div class="msg-name">' + esc(name) + '</div>' +
    '<div class="msg-text">' + esc(text) + '</div>' +
    (t ? '<div class="msg-time">' + t + '</div>' : '');
  el.appendChild(div); el.scrollTop = el.scrollHeight;
}

function addSystemMsg(text) {
  const el = document.getElementById('chatMessages');
  const div = document.createElement('div'); div.className = 'chat-msg';
  div.innerHTML = '<div class="msg-name system">system</div><div class="msg-text">' + esc(text) + '</div>';
  el.appendChild(div); el.scrollTop = el.scrollHeight;
}

function switchTab(tab, btn) {
  document.querySelectorAll('.sidebar-tabs button').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById(tab === 'chat' ? 'tabChat' : 'tabParticipants').classList.add('active');
  if (tab === 'participants') updateParticipants();
}

function toggleChat() {
  S.chatOpen = !S.chatOpen;
  document.getElementById('chatSidebar').className = S.chatOpen ? 'sidebar' : 'sidebar hidden';
  document.getElementById('btnChat').className = S.chatOpen ? 'ctrl-circle on' : 'ctrl-circle';
}

function updateParticipants() {
  const el = document.getElementById('participantsList');
  let html = '<div class="participant-item">' +
    '<div class="p-avatar">' + esc((S.userName || 'G')[0].toUpperCase()) + '</div>' +
    '<div><div class="p-name">' + esc(S.userName) + '</div><div class="p-you">you</div></div>' +
    '<div class="p-icons">' +
      '<span class="' + (S.micOn ? 'on' : 'off') + '">' + (S.micOn ? 'MIC' : 'MUTE') + '</span>' +
      '<span class="' + (S.cameraOn ? 'on' : 'off') + '">' + (S.cameraOn ? 'CAM' : 'OFF') + '</span>' +
    '</div></div>';
  for (const [pid, peer] of Object.entries(S.peers)) {
    html += '<div class="participant-item">' +
      '<div class="p-avatar">' + esc((peer.name || 'P')[0].toUpperCase()) + '</div>' +
      '<div><div class="p-name">' + esc(peer.name) + '</div></div>' +
      '<div class="p-icons">' +
        '<span class="' + (peer.mic ? 'on' : 'off') + '">' + (peer.mic ? 'MIC' : 'MUTE') + '</span>' +
        '<span class="' + (peer.camera ? 'on' : 'off') + '">' + (peer.camera ? 'CAM' : 'OFF') + '</span>' +
      '</div></div>';
  }
  el.innerHTML = html;
}

function copyLink() {
  const link = location.origin + '/room/' + S.roomId;
  navigator.clipboard.writeText(link).then(() => showToast('Invite link copied'));
}

function leaveRoom() {
  if (S.localStream) S.localStream.getTracks().forEach(t => t.stop());
  if (S.screenStream) S.screenStream.getTracks().forEach(t => t.stop());
  if (S.ws) { S.ws.close(); S.ws = null; }
  for (const [pid, peer] of Object.entries(S.peers)) { try { peer.pc.close(); } catch {} }
  S.peers = {}; S.localStream = null; S.screenStream = null;
  S.cameraOn = false; S.micOn = false; S.screenOn = false;
  S.roomId = null; S.peerId = null;
  document.getElementById('app').style.display = 'none';
  document.getElementById('lobby').style.display = '';
  document.getElementById('chatMessages').innerHTML = '';
  history.pushState(null, '', '/');
  updateButtons(); loadRooms();
}

function showToast(text) {
  const el = document.getElementById('toast');
  el.textContent = text; el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2500);
}

function timeAgo(iso) {
  if (!iso) return '';
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  return Math.floor(diff / 86400) + 'd ago';
}

function esc(s) {
  if (!s) return '';
  const d = document.createElement('div'); d.textContent = s; return d.innerHTML;
}

if (S.roomId) {
  window.addEventListener('DOMContentLoaded', () => {
    S.userName = 'Guest';
    document.getElementById('userName').value = S.userName;
    joinRoom(S.roomId);
  });
} else {
  window.addEventListener('DOMContentLoaded', () => {
    loadRooms(); updateButtons();
    setInterval(loadRooms, 10000);
  });
}
</script>
</body>
</html>`;
