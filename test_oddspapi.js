const httpGet = (url) => new Promise((resolve, reject) => {
  require('https').get(url, (res) => {
    let d = ''; res.on('data', c => d+=c); res.on('end', () => resolve(d));
  }).on('error', reject);
});

require('dotenv').config();
const apiKey = process.env.ODDS_API_KEY;

if (!apiKey) {
  console.log('Sem ODDS_API_KEY no .env!');
  process.exit();
}

httpGet(`https://api.oddspapi.io/v1/fixtures?api_key=${apiKey}&sport=esports`).then(data => {
  console.log('DATA_LENGTH:', data.length);
  try {
    const json = JSON.parse(data);
    if (!Array.isArray(json) && !json.data) {
        console.log("FORMATO DESCONHECIDO:", Object.keys(json));
    }
    const events = Array.isArray(json) ? json : (json.data || json.response || json.fixtures || json.events || []);
    if (events.length > 0) {
      console.log('EXEMPLO DE EVENTO:', JSON.stringify(events[0], null, 2));
    } else {
      console.log('VEIO VAZIO OU NÃO TEM ARRAY DENTRO DA RAIZ:', data.slice(0, 500));
    }
  } catch(e) {
    console.log('JSON Parse ERROR:', e.message);
    console.log('Raw data:', data.slice(0, 500));
  }
});
