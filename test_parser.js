const fs = require('fs');
const safeParse = (str, def) => { try { return JSON.parse(str); } catch(e) { return def; } };
const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

const payload = [{"fixtureId":"id1800245470264392","participant1Id":340968,"participant2Id":587561,"sportId":18,"tournamentId":2454,"seasonId":null,"statusId":0,"hasOdds":true,"startTime":"2026-04-02T08:00:00.000Z","trueStartTime":null,"trueEndTime":null,"updatedAt":"2026-03-31T07:08:16.174Z","bookmakerOdds":{"1xbet":{"bookmakerIsActive":true,"bookmakerFixtureId":"316247084","fixturePath":"https://1xbet.com/line/esport-league-of-legends/1721744-e/316247084-dplus-kia-ns-redforce","markets":{"183":{"outcomes":{"183":{"players":{"0":{"active":true,"betslip":null,"bookmakerOutcomeId":"1","changedAt":"2026-03-26T20:31:59.435797+00:00","limit":null,"playerName":null,"price":1.31,"exchangeMeta":{}}}}},"bookmakerMarketId":"1"},"185":{"outcomes":{"185":{"players":{"0":{"active":true,"betslip":null,"bookmakerOutcomeId":"3","changedAt":"2026-03-26T20:31:59.435797+00:00","limit":null,"playerName":null,"price":3.375,"exchangeMeta":{}}}}},"bookmakerMarketId":"1"}}}}},{"fixtureId":"id1800245470264394","participant1Id":240610,"participant2Id":240620,"sportId":18,"tournamentId":2454,"seasonId":null,"statusId":0,"hasOdds":true,"startTime":"2026-04-02T10:00:00.000Z","trueStartTime":null,"trueEndTime":null,"updatedAt":"2026-03-31T10:06:40.846Z","bookmakerOdds":{"1xbet":{"bookmakerIsActive":true,"bookmakerFixtureId":"316249552","fixturePath":"https://1xbet.com/line/esport-league-of-legends/1721744-e/316249552-drx-dn-soopers","markets":{"183":{"outcomes":{"183":{"players":{"0":{"active":true,"betslip":null,"bookmakerOutcomeId":"1","changedAt":"2026-04-01T19:51:28.567837+00:00","limit":null,"playerName":null,"price":2.307,"exchangeMeta":{}}}}},"bookmakerMarketId":"1"},"185":{"outcomes":{"185":{"players":{"0":{"active":true,"betslip":null,"bookmakerOutcomeId":"3","changedAt":"2026-04-01T19:51:28.567837+00:00","limit":null,"playerName":null,"price":1.6,"exchangeMeta":{}}}}},"bookmakerMarketId":"1"}}}}},{"fixtureId":"id1800245470264424","participant1Id":240610,"participant2Id":340968,"sportId":18,"tournamentId":2454,"seasonId":null,"statusId":0,"hasOdds":true,"startTime":"2026-04-04T10:00:00.000Z","trueStartTime":null,"trueEndTime":null,"updatedAt":"2026-04-01T15:41:41.822Z","bookmakerOdds":{"1xbet":{"bookmakerIsActive":true,"bookmakerFixtureId":"316249556","fixturePath":"https://1xbet.com/line/esport-league-of-legends/1721744-e/316249556-drx-dplus-kia","markets":{"183":{"outcomes":{"183":{"players":{"0":{"active":true,"betslip":null,"bookmakerOutcomeId":"1","changedAt":"2026-04-01T14:51:23.688848+00:00","limit":null,"playerName":null,"price":3.47,"exchangeMeta":{}}}}},"bookmakerMarketId":"1"},"185":{"outcomes":{"185":{"players":{"0":{"active":true,"betslip":null,"bookmakerOutcomeId":"3","changedAt":"2026-04-01T14:51:23.688848+00:00","limit":null,"playerName":null,"price":1.296,"exchangeMeta":{}}}}},"bookmakerMarketId":"1"}}}}}]];

let oddsCache = {};
let cached = 0;

for (const ev of payload) {
  if (!ev.bookmakerOdds || !ev.bookmakerOdds['1xbet']) continue;
  
  const bk = ev.bookmakerOdds['1xbet'];
  if (!bk.markets) continue;

  const matchWinnerOutcomes = Object.values(bk.markets).filter(m => m.bookmakerMarketId === '1');
  if (matchWinnerOutcomes.length < 2) continue;

  let prices = [];
  for (const out of matchWinnerOutcomes) {
    try {
      const outKey = Object.keys(out.outcomes)[0];
      const price = parseFloat(out.outcomes[outKey].players['0'].price);
      if (!isNaN(price)) prices.push(price);
    } catch(e) {}
  }
  
  if (prices.length < 2) continue;
  
  const t1Odd = prices[0];
  const t2Odd = prices[1];

  const urlSlug = (bk.fixturePath || '').split('/').pop().replace(/^\d+-/, '').replace(/-/g, ' ');

  const p1Name = urlSlug; 
  const p2Name = urlSlug;

  const entry = { t1: t1Odd.toFixed(2), t2: t2Odd.toFixed(2), bookmaker: '1xBet', t1Name: p1Name, t2Name: p2Name };
  const nameKey = ev.fixtureId || String(ev.participant1Id);
  oddsCache[`esports_${nameKey}`] = entry;
  cached++;
}

console.log("----- CACHE -----");
console.log(oddsCache);
console.log("Cached items: " + cached);

function findOdds(sport, t1, t2) {
  const nt1 = norm(t1), nt2 = norm(t2);
  for (const [cacheKey, val] of Object.entries(oddsCache)) {
    if (!cacheKey.startsWith(`${sport}_`)) continue;
    if (!val.t1Name || !val.t2Name) continue;
    const vt1 = norm(val.t1Name), vt2 = norm(val.t2Name);
    if (!vt1 || !vt2) continue;
    console.log(`Matching: ${nt1} vs ${vt1} && ${nt2} vs ${vt2}`);
    if ((vt1.includes(nt1) || nt1.includes(vt1)) && (vt2.includes(nt2) || nt2.includes(vt2))) {
      return { t1: val.t1, t2: val.t2, bookmaker: val.bookmaker };
    }
    // inverted
    if ((vt1.includes(nt2) || nt2.includes(vt1)) && (vt2.includes(nt1) || nt1.includes(vt2))) {
      return { t1: val.t2, t2: val.t1, bookmaker: val.bookmaker };
    }
  }
  return null;
}

console.log("FIND drx vs dnsoopers:", findOdds('esports', 'DRX', 'DN Soopers'));
console.log("FIND dpluskia vs nsredforce:", findOdds('esports', 'Dplus KIA', 'NS RedForce'));

