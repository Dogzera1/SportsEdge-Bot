const https = require('https');
require('dotenv').config();

const apiKey = process.env.ODDS_API_KEY;

const url = `https://api.oddspapi.io/v4/fixtures?apiKey=${apiKey}&sportId=18`;

console.log('--- TESTE V4 FIXTURES ---');

https.get(url, (res) => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => {
        console.log('Status:', res.statusCode);
        console.log('Response (first 2000 chars):', d.slice(0, 2000));
    });
}).on('error', e => console.error(e));
