const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { google } = require('googleapis');

const PORT = 3000;
const RECORDINGS_DIR = '/var/recordings';
const GDRIVE_FOLDER_ID = '14Rt0E2TywUAuZhHHjXmwqrjS5bi1inTW';

const OAUTH_CLIENT_PATH = '/app/oauth-client.json';
const OAUTH_TOKEN_PATH  = '/app/oauth-token.json';

let driveClient = null;

// ─── Google Drive OAuth ─────────────────────────
function initGoogleDrive() {
  try {
    if (!fs.existsSync(OAUTH_CLIENT_PATH) || !fs.existsSync(OAUTH_TOKEN_PATH)) {
      console.log('[GDRIVE] OAuth files missing');
      return;
    }

    const creds = JSON.parse(fs.readFileSync(OAUTH_CLIENT_PATH));
    const token = JSON.parse(fs.readFileSync(OAUTH_TOKEN_PATH));

    const { client_secret, client_id, redirect_uris } = creds.installed;

    const oAuth2Client = new google.auth.OAuth2(
      client_id,
      client_secret,
      redirect_uris[0]
    );

    oAuth2Client.setCredentials(token);

    driveClient = google.drive({
      version: 'v3',
      auth: oAuth2Client
    });

    console.log('[GDRIVE] OAuth client initialized — auto-upload enabled');
  } catch (err) {
    console.error('[GDRIVE] Init error:', err.message);
  }
}

async function uploadToGoogleDrive(filePath) {
  if (!driveClient) return null;

  const fileName = path.basename(filePath);
  const sizeMB = (fs.statSync(filePath).size / (1024 * 1024)).toFixed(2);

  console.log(`[GDRIVE] Uploading ${fileName} (${sizeMB} MB)...`);

  try {
    const res = await driveClient.files.create({
      requestBody: {
        name: fileName,
        parents: [GDRIVE_FOLDER_ID]
      },
      media: {
        mimeType: 'video/mp4',
        body: fs.createReadStream(filePath)
      },
      fields: 'id, name, webViewLink'
    });

    console.log(`[GDRIVE] Done: ${res.data.name}`);
    return res.data;

  } catch (err) {
    console.error('[GDRIVE] Upload failed:', err.message);
    return null;
  }
}

// ─── FLV → MP4 Conversion ───────────────────────
function convertToMp4(flvPath) {
  return new Promise(resolve => {

    const mp4Path = flvPath.replace(/\.flv$/, '.mp4');

    console.log(`[CONVERT] ${path.basename(flvPath)} → MP4`);

    execFile('ffmpeg', [
      '-y',
      '-i', flvPath,
      '-c', 'copy',
      '-movflags', '+faststart',
      mp4Path
    ], (err) => {

      if (err) {
        console.error('[CONVERT] Failed:', err.message);
        resolve(null);
      } else {
        console.log(`[CONVERT] Done: ${path.basename(mp4Path)}`);
        resolve(mp4Path);
      }
    });
  });
}

// ─── State ──────────────────────────────────────
let drone = null;
let viewers = new Set();
let lastTelemetry = null;
let activeRecording = null;
let processedFiles = new Set();

function broadcastToViewers(data) {
  const msg = JSON.stringify(data);
  viewers.forEach(v => {
    if (v.readyState === WebSocket.OPEN) v.send(msg);
  });
}

// ─── Recording Watcher ──────────────────────────
function scanRecordings() {

  if (!fs.existsSync(RECORDINGS_DIR)) return;

  const files = fs.readdirSync(RECORDINGS_DIR)
    .filter(f => f.endsWith('.flv'))
    .map(f => {
      const fp = path.join(RECORDINGS_DIR, f);
      const stat = fs.statSync(fp);
      return { name: f, path: fp, size: stat.size, mtime: stat.mtimeMs };
    });

  const now = Date.now();
  const growing = files.find(f => (now - f.mtime) < 3000 && f.size > 0);

  if (growing && !activeRecording) {
    activeRecording = {
      startTime: new Date().toISOString(),
      filename: growing.name
    };
    console.log(`[RECORD] Recording started: ${growing.name}`);
  }

  if (!growing && activeRecording) {

    const completed = files.find(f => f.name === activeRecording.filename);

    if (completed && !processedFiles.has(completed.name)) {

      processedFiles.add(completed.name);

      console.log(`[RECORD] Recording stopped: ${completed.name}`);

      convertToMp4(completed.path).then(mp4Path => {

        const uploadPath = mp4Path || completed.path;

        uploadToGoogleDrive(uploadPath);

      });
    }

    activeRecording = null;
  }
}

setInterval(scanRecordings, 2000);

// ─── HTTP Server ────────────────────────────────
const httpServer = http.createServer((req, res) => {

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/recording-status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      isRecording: !!activeRecording,
      gdriveEnabled: !!driveClient
    }));
  }

  res.writeHead(404);
  res.end();
});

// ─── WebSocket ──────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws, req) => {

  const url = new URL(req.url, `http://${req.headers.host}`);
  const role = url.searchParams.get('role');

  if (role === 'drone') {
    drone = ws;
    ws.on('message', data => {
      try {
        const telemetry = JSON.parse(data);
        lastTelemetry = telemetry;
        broadcastToViewers(telemetry);
      } catch {}
    });
    ws.on('close', () => { drone = null; });
  } else {
    viewers.add(ws);
    if (lastTelemetry) ws.send(JSON.stringify(lastTelemetry));
    ws.on('close', () => viewers.delete(ws));
  }
});

// ─── Start ──────────────────────────────────────
initGoogleDrive();
httpServer.listen(PORT, () => {
  console.log(`[TELEMETRY] Server on :${PORT}`);
});
