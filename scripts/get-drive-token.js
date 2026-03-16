/**
 * One-time script to get a Google Drive OAuth2 refresh token.
 *
 * Usage:
 *   1. Set GDRIVE_CLIENT_ID and GDRIVE_CLIENT_SECRET in .env
 *   2. Run: node scripts/get-drive-token.js
 *   3. Open the URL in your browser, sign in, and authorize
 *   4. You'll be redirected to localhost — copy the "code" from the URL
 *   5. Paste the code here
 *   6. Copy the refresh token into .env as GDRIVE_REFRESH_TOKEN
 */
require('dotenv').config();
const { google } = require('googleapis');
const http = require('http');

const clientId = process.env.GDRIVE_CLIENT_ID;
const clientSecret = process.env.GDRIVE_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error('Set GDRIVE_CLIENT_ID and GDRIVE_CLIENT_SECRET in .env first.');
  process.exit(1);
}

const REDIRECT_URI = 'http://localhost:3333';
const oauth2 = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

const url = oauth2.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: ['https://www.googleapis.com/auth/drive'],
});

console.log('\nOpening browser for Google authorization...\n');
console.log('If it does not open automatically, go to:\n');
console.log(url);
console.log('\nWaiting for authorization...\n');

// Start a tiny server to catch the redirect
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, REDIRECT_URI);
  const code = u.searchParams.get('code');
  const error = u.searchParams.get('error');

  if (error) {
    res.end('Authorization denied: ' + error);
    server.close();
    process.exit(1);
  }

  if (!code) {
    res.end('No code received');
    return;
  }

  try {
    const { tokens } = await oauth2.getToken(code);
    res.end('Success! You can close this tab and return to the terminal.');
    console.log('=== SUCCESS ===\n');
    console.log('Add this to your .env:\n');
    console.log(`GDRIVE_REFRESH_TOKEN=${tokens.refresh_token}\n`);
  } catch (e) {
    res.end('Error: ' + e.message);
    console.error('Error exchanging code:', e.message);
  }
  server.close();
});

server.listen(3333, () => {
  // Try to open in browser
  require('child_process').exec(`open "${url}"`);
});
