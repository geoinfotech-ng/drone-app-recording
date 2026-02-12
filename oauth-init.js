const fs = require('fs');
const readline = require('readline');
const { google } = require('googleapis');

const creds = JSON.parse(fs.readFileSync('./oauth-client.json'));
const { client_secret, client_id, redirect_uris } = creds.installed;

const oAuth2Client = new google.auth.OAuth2(
  client_id,
  client_secret,
  redirect_uris[0]
);

const authUrl = oAuth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: ['https://www.googleapis.com/auth/drive.file'],
});

console.log('\nAuthorize this app by visiting this URL:\n', authUrl);

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

rl.question('\nEnter the code from that page here: ', async (code) => {
  const { tokens } = await oAuth2Client.getToken(code);
  fs.writeFileSync('oauth-token.json', JSON.stringify(tokens));
  console.log('\nToken saved to oauth-token.json');
  rl.close();
});
