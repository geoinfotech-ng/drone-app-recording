const http = require('http');
const { WebSocketServer } = require('ws');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { google } = require('googleapis');

const PORT = 3000;
const RECORDINGS_DIR = '/var/recordings';
const GDRIVE_FOLDER_ID = '14Rt0E2TywUAuZhHHjXmwqrjS5bi1inTW';

const OAUTH_CLIENT_PATH = '/app/oauth-client.json';
const OAUTH_TOKEN_PATH  = '/app/oauth-token.json';

let driveClient = null;

// ───────────────────────────────────────────────
// GOOGLE DRIVE (OAuth)
// ───────────────────────────────────────────────
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

    console.log('[GDRIVE] OAuth initialized — auto-upload enabled');

  } catch (err) {
    console.error('[GDRIVE] Init error:', err.message);
  }
}

async function uploadToGoogleDrive(filePath) {
  if (!driveClient) return;

  const fileName = path.basename(filePath);
  const stat = fs.statSync(filePath);
  const sizeMB = (stat.size / (1024 * 1024)).toFixed(2);

  console.log(`[GDRIVE] Uploading ${fileName} (${sizeMB} MB)`);

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
  } catch (err) {
    console.error('[GDRIVE] Upload failed:', err.message);
  }
}

// ───────────────────────────────────────────────
// FLV → MP4 CONVERSION (STREAM SAFE)
// ───────────────────────────────────────────────
function convertToMp4(flvPath) {
  return new Promise((resolve) => {

    const mp4Path = flvPath.replace(/\.flv$/, '.mp4');

    console.log(`[CONVERT] ${path.basename(flvPath)} → MP4`);

    const ffmpeg = spawn('ffmpeg', [
      '-y',
      '-loglevel', 'error',
      '-i', flvPath,
      '-c', 'copy',
      '-movflags', '+faststart',
      mp4Path
    ]);

    ffmpeg.stderr.on('data', data => {
      // Only errors printed due to loglevel
      console.error('[CONVERT]', data.toString().trim());
    });

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        console.log(`[CONVERT] Done: ${path.basename(mp4Path)}`);
        resolve(mp4Path);
      } else {
        console.error('[CONVERT] Failed with exit code', code);
        resolve(null);
      }
    });

  });
}

// ───────────────────────────────────────────────
// RECORDING WATCHER
// ───────────────────────────────────────────────
let activeRecording = null;
let processed = new Set();

function scanRecordings() {

  if (!fs.existsSync(RECORDINGS_DIR)) return;

  const files = fs.readdirSync(RECORDINGS_DIR)
    .filter(f => f.endsWith('.flv'))
    .map(f => {
      const fp = path.join(RECORDINGS_DIR, f);
      const stat = fs.statSync(fp);
      return {
        name: f,
        path: fp,
        size: stat.size,
        mtime: stat.mtimeMs
      };
    });

  const now = Date.now();
  const growing = files.find(f => (now - f.mtime) < 5000 && f.size > 0);

  if (growing && !activeRecording) {
    activeRecording = growing.name;
    console.log(`[RECORD] Started: ${growing.name}`);
  }

  if (!growing && activeRecording) {

    const completed = files.find(f => f.name === activeRecording);

    if (completed && !processed.has(completed.name)) {

      processed.add(completed.name);

      console.log(`[RECORD] Stopped: ${completed.name}`);

      convertToMp4(completed.path)
        .then(mp4Path => {

          const finalPath = mp4Path || completed.path;

          return uploadToGoogleDrive(finalPath);

        })
        .catch(err => {
          console.error('[PIPELINE] Error:', err.message);
        });
    }

    activeRecording = null;
  }
}

setInterval(scanRecordings, 3000);

// ───────────────────────────────────────────────
// HTTP + WS
// ───────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server });

wss.on('connection', () => {});

initGoogleDrive();

server.listen(PORT, () => {
  console.log(`[TELEMETRY] Server running on ${PORT}`);
});
