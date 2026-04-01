const fs = require('fs');
let txt = fs.readFileSync('server.js', 'utf8');

// 1. Remove oddspapiAllowed from utils import
txt = txt.replace(/oddsApiAllowed, oddspapiAllowed/g, 'oddsApiAllowed');

// 2. Replace the massive odds block
const startMarker = "// ── OddsPapi Quota (MMA) ──";
const endMarker = "function findOdds(sport, t1, t2) {";

const startIndex = txt.indexOf(startMarker);
const endIndex = txt.indexOf(endMarker);

if (startIndex === -1 || endIndex === -1) {
  console.log("Error: markers not found");
  process.exit(1);
}

const before = txt.substring(0, startIndex);
const after = txt.substring(endIndex);

const replacement = `// ── Dota T1 Keywords ──
const DOTA_T1_KEYWORDS = ['esl', 'dreamleague', 'the international', 'pgl', 'betboom',
  'dpc', 'riyadh masters', 'bali major', 'major', 'champions league',
  'fissure', 'blast', 'parivision', 'elite league', 'gamers8',
  'thunderpick', 'pinnacle cup'];

// ── Odds APIs ──
async function fetchOdds(sport) {
  if (sport === 'esports') return await fetchEsportsOdds();
  // Apenas Esports é suportado
}

// The Odds API 429 backoff state
let esportsBackoffUntil = 0;
const ESPORTS_BACKOFF_TTL = 2 * 60 * 60 * 1000; // 2h backoff on 429

async function fetchEsportsOdds() {
  if (!THE_ODDS_KEY) return;
  if (esportsOddsFetching) return;
  const now = Date.now();
  if (now < esportsBackoffUntil) return;
  if (now - lastEsportsOddsUpdate < ESPORTS_ODDS_TTL) return;

  esportsOddsFetching = true;
  try {
    const sports = ['leagueoflegends_lol', 'dota2_dota2'];
    let cached = 0;
    
    for (const sport of sports) {
      const url = \`https://api.the-odds-api.com/v4/sports/\${sport}/odds/?apiKey=\${THE_ODDS_KEY}&regions=us,eu,uk&markets=h2h\`;
      const r = await httpGet(url);
      
      if (r.status === 429) {
        esportsBackoffUntil = Date.now() + ESPORTS_BACKOFF_TTL;
        log('WARN', 'ODDS', \`The Odds API 429 (Rate Limit)\`);
        break;
      }
      if (r.status !== 200) {
        continue;
      }

      const events = safeParse(r.body, []);
      for (const ev of events) {
        if (!ev.home_team || !ev.away_team) continue;
        const bms = ev.bookmakers || [];
        const bk = bms.find(b => b.key === 'pinnacle') || bms[0];
        if (!bk) continue;
        
        const market = bk.markets?.find(m => m.key === 'h2h');
        if (!market || !market.outcomes || market.outcomes.length < 2) continue;

        const p1Name = ev.home_team;
        const p2Name = ev.away_team;
        
        const o1 = market.outcomes.find(o => o.name === p1Name) || market.outcomes[0];
        const o2 = market.outcomes.find(o => o.name === p2Name) || market.outcomes[1];
        
        if (!o1 || !o2 || !o1.price || !o2.price) continue;
        
        const t1Odd = parseFloat(o1.price);
        const t2Odd = parseFloat(o2.price);
        if (t1Odd < 1.01 || t2Odd < 1.01) continue;

        const entry = { t1: t1Odd.toFixed(2), t2: t2Odd.toFixed(2), bookmaker: bk.title, t1Name: p1Name, t2Name: p2Name };
        const nameKey = norm(p1Name) + '_' + norm(p2Name);
        oddsCache[\`esports_\${nameKey}\`] = entry;
        cached++;

        try {
          stmts.insertOddsHistory.run('esports', nameKey, p1Name, p2Name, t1Odd, t2Odd, bk.title);
        } catch(_) {}
      }
    }
    
    log('INFO', 'ODDS', \`Esports: \${cached} fixtures com odds (The Odds API)\`);
    lastEsportsOddsUpdate = Date.now();
  } catch(e) {
    log('ERROR', 'ODDS', \`Esports odds: \${e.message}\`);
  } finally {
    esportsOddsFetching = false;
  }
}

`;

fs.writeFileSync('server.js', before + replacement + after);
console.log("Replaced successfully!");
