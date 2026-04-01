const https = require('https');
require('dotenv').config();

const apiKey = process.env.THE_ODDS_API_KEY;
const sports = ['leagueoflegends_lol', 'dota2_dota2', 'esports_league_of_legends', 'esports_dota2'];
const regions = ['us', 'eu', 'uk', 'au'];

console.log('--- TESTE DE ODDS (MÚLTIPLAS CATEGORIAS E REGIÕES) ---');

async function checkSport(sport, region) {
    return new Promise((resolve) => {
        const url = `https://api.the-odds-api.com/v4/sports/${sport}/odds/?apiKey=${apiKey}&regions=${region}&markets=h2h`;
        https.get(url, (res) => {
            let data = '';
            res.on('data', d => data += d);
            res.on('end', () => {
                console.log(`[${res.statusCode}] Sport: ${sport.padEnd(25)} | Region: ${region.padEnd(3)} | Data Length: ${data.length}`);
                if (res.statusCode === 200 && data.length > 50) {
                    const parsed = JSON.parse(data);
                    if (Array.isArray(parsed) && parsed.length > 0) {
                        console.log(`   ✅ SUCESSO! Encontrados ${parsed.length} eventos para ${sport} em ${region}`);
                        console.log(`   Exemplo: ${parsed[0].home_team} vs ${parsed[0].away_team}`);
                    }
                }
                resolve();
            });
        }).on('error', e => {
            console.log(`   ❌ Erro em ${sport}/${region}: ${e.message}`);
            resolve();
        });
    });
}

(async () => {
    for (const s of sports) {
        for (const r of regions) {
            await checkSport(s, r);
        }
    }
})();
