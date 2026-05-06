const https = require('https');
require('dotenv').config();

const apiKey = process.env.THE_ODDS_API_KEY;
https.get(`https://api.the-odds-api.com/v4/sports/?apiKey=${apiKey}&all=true`, (res) => {
    let data = '';
    res.on('data', (d) => data += d);
    res.on('end', () => {
        const sports = JSON.parse(data);
        console.log('--- ESPORTS FOUND (ALL=TRUE) ---');
        sports.forEach(s => {
            if (s.group.toLowerCase().includes('esports') || s.key.includes('lol') || s.key.includes('dota')) {
                console.log(`${s.key} | ${s.title} | ${s.group}`);
            }
        });
        console.log('\n--- ALL GROUPS ---');
        console.log([...new Set(sports.map(s => s.group))].join(', '));
    });
});
