const { httpGet, safeParse, norm } = require('../lib/utils');
const { db, stmts } = require('../lib/database')();

const UFC_BASE = 'http://www.ufcstats.com';

async function refreshEvents() {
  try {
    const r = await httpGet(`${UFC_BASE}/statistics/events/upcoming`);
    if (r.status !== 200) {
      console.log(`[MMA] refreshEvents: HTTP ${r.status}`);
      return;
    }
    const events = parseUpcomingEvents(r.body);
    console.log(`[MMA] refreshEvents: encontrados ${events.length} eventos`);
    for (const ev of events) {
      try {
        stmts.upsertEvent.run(ev.id, 'mma', ev.name, ev.date, ev.location, ev.url);
      } catch(_) {}
    }
  } catch(e) {
    console.log('[MMA] refreshEvents:', e.message);
  }
}

async function scrapeEventMatches(eventId) {
  try {
    const r = await httpGet(`${UFC_BASE}/event-details/${eventId}`);
    if (r.status !== 200) return [];
    
    const matches = parseEventFights(r.body, eventId);
    for (const m of matches) {
      try {
        stmts.upsertMatch.run({
          id: m.id,
          sport: 'mma',
          eventId: m.eventId,
          eventName: m.eventName,
          p1Name: m.fighter1Name,
          p2Name: m.fighter2Name,
          p1Url: m.fighter1Url,
          p2Url: m.fighter2Url,
          category: m.weightClass,
          isTitle: m.isTitleFight,
          isMain: m.isMainEvent,
          status: m.winner ? 'completed' : 'upcoming',
          winner: m.winner,
          eventDate: m.eventDate
        });
      } catch(_) {}
    }
    return stmts.getMatchesByEvent.all(eventId, 'mma');
  } catch(e) {
    console.log('[MMA] scrapeEventMatches:', e.message);
    return [];
  }
}

async function scrapeAthlete(url) {
  try {
    const r = await httpGet(url);
    if (r.status !== 200) return null;
    
    const stats = parseFighterStats(r.body, url);
    if (!stats) return null;
    
    stmts.upsertAthlete.run({
      id: stats.id,
      sport: 'mma',
      name: stats.name,
      nickname: stats.nickname,
      stats: JSON.stringify(stats),
      url
    });
    
    return stmts.getAthlete.get(stats.id);
  } catch(e) {
    console.log('[MMA] scrapeAthlete:', e.message);
    return null;
  }
}

async function searchAthlete(name) {
  const lastName = name.trim().split(/\s+/).pop();
  try {
    const r = await httpGet(
      `${UFC_BASE}/statistics/fighters/search?query=${encodeURIComponent(lastName)}&action=search`
    );
    if (r.status === 200) {
      const linkRegex = /href="(http:\/\/www.ufcstats.com\/fighter-details\/([a-z0-9]+))"[^>]*>\s*([^<]{2,40}?)\s*<\/a>/g;
      let m;
      while ((m = linkRegex.exec(r.body)) !== null) {
        if (norm(name).includes(norm(m[3].trim()))) {
          return await scrapeAthlete(m[1]);
        }
      }
    }
  } catch(_) {}
  return null;
}

// ── Parsers ──────────────────────────────────────────────────

function toISODate(dateStr) {
  if (!dateStr) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
  const months = { january:'01', february:'02', march:'03', april:'04', may:'05', june:'06',
    july:'07', august:'08', september:'09', october:'10', november:'11', december:'12' };
  const m = dateStr.match(/(\w+)\s+(\d{1,2}),\s+(\d{4})/);
  if (m) {
    const mon = months[m[1].toLowerCase()];
    if (mon) return `${m[3]}-${mon}-${m[2].padStart(2, '0')}`;
  }
  return dateStr;
}

function parseUpcomingEvents(html) {
  const events = [];
  const seen = new Set();
  const linkRegex = /href="(http:\/\/www\.ufcstats\.com\/event-details\/([a-z0-9]+))"[^>]*>\s*([^<]{3,80}?)\s*</g;
  let match;
  while ((match = linkRegex.exec(html)) !== null) {
    const eventUrl = match[1];
    const id = match[2];
    const name = match[3].trim();
    if (!name || seen.has(id) || name.length < 3) continue;
    if (!name.toLowerCase().includes('ufc') && !name.toLowerCase().includes('fight')) continue;
    seen.add(id);

    const pos = match.index;
    const ctx = html.slice(Math.max(0, pos - 100), pos + 800);

    const dateMatch = ctx.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}/);
    const date = dateMatch ? toISODate(dateMatch[0]) : '';

    const locMatch = ctx.match(/([A-Z][a-z]+(?:[\s][A-Z][a-z]+)*,\s*[A-Za-z\s,]+?)(?:<|\n|$)/);
    const location = locMatch ? locMatch[1].replace(/<[^>]+>/g, '').trim().slice(0, 60) : '';

    events.push({ id, name, url: eventUrl, date, location });
  }
  return events;
}

function parseEventFights(html, eventId) {
  const fights = [];

  const titleMatch = html.match(/<span[^>]*class="b-content__title-highlight"[^>]*>\s*([^<]+?)\s*<\/span>/);
  const eventName = titleMatch ? titleMatch[1].trim() : '';

  const dateMatch = html.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}/);
  const eventDate = dateMatch ? toISODate(dateMatch[0]) : '';

  const fightRowRegex = /data-link="http:\/\/www\.ufcstats\.com\/fight-details\/([a-z0-9]+)"([\s\S]*?)(?=data-link=|<\/tbody>|$)/g;
  let rowMatch;
  let idx = 0;

  while ((rowMatch = fightRowRegex.exec(html)) !== null) {
    const fightId = rowMatch[1];
    const rowHtml = rowMatch[2];

    const rowFighters = [];
    const rfRegex = /href="(http:\/\/www\.ufcstats\.com\/fighter-details\/([a-z0-9]+))"[^>]*>\s*([^<]{2,40}?)\s*<\/a>/g;
    let rf;
    while ((rf = rfRegex.exec(rowHtml)) !== null) {
      const name = rf[3].trim();
      if (name.length >= 2) rowFighters.push({ url: rf[1], id: rf[2], name });
    }
    if (rowFighters.length < 2) { idx++; continue; }

    const weightClasses = ['Heavyweight', 'Light Heavyweight', 'Middleweight', 'Welterweight',
      'Lightweight', 'Featherweight', 'Bantamweight', 'Flyweight',
      "Women's Featherweight", "Women's Bantamweight", "Women's Flyweight", "Women's Strawweight"];
    let weightClass = 'Unknown';
    for (const wc of weightClasses) {
      if (rowHtml.includes(wc)) { weightClass = wc; break; }
    }

    const isTitleFight = /title bout|championship/i.test(rowHtml) ? 1 : 0;

    const winnerMatch = rowHtml.match(/b-fight-details__table-img_style_checkmark[\s\S]{0,400}?fighter-details\/[a-z0-9]+"[^>]*>\s*([^<]{2,40}?)\s*<\/a>/);
    const winner = winnerMatch ? winnerMatch[1].trim() : null;

    fights.push({
      id: fightId,
      eventId,
      eventName,
      eventDate,
      fighter1Name: rowFighters[0].name,
      fighter1Url: rowFighters[0].url,
      fighter2Name: rowFighters[1].name,
      fighter2Url: rowFighters[1].url,
      weightClass,
      isTitleFight,
      isMainEvent: idx === 0 ? 1 : 0,
      winner: winner || null
    });
    idx++;
  }

  // Fallback: pair all fighter links on the page
  if (!fights.length) {
    const allLinks = [];
    const allLinkRegex = /href="(http:\/\/www\.ufcstats\.com\/fighter-details\/([a-z0-9]+))"[^>]*>\s*([^<]{2,40}?)\s*<\/a>/g;
    let lm;
    while ((lm = allLinkRegex.exec(html)) !== null) {
      const name = lm[3].trim();
      if (name.length >= 2) allLinks.push({ url: lm[1], id: lm[2], name });
    }
    const seen = new Set();
    const unique = allLinks.filter(f => { if (seen.has(f.id)) return false; seen.add(f.id); return true; });
    for (let i = 0; i < unique.length - 1; i += 2) {
      const f1 = unique[i], f2 = unique[i + 1];
      fights.push({
        id: `${eventId}_${i}`, eventId, eventName, eventDate,
        fighter1Name: f1.name, fighter1Url: f1.url,
        fighter2Name: f2.name, fighter2Url: f2.url,
        weightClass: 'Unknown', isTitleFight: 0, isMainEvent: i === 0 ? 1 : 0, winner: null
      });
    }
  }

  return fights;
}

function parseFighterStats(html, fighterUrl) {
  const fighterId = fighterUrl.split('/').pop();

  const nameMatch = html.match(/<span[^>]*class="b-content__title-highlight"[^>]*>\s*([^<]+?)\s*<\/span>/);
  const name = nameMatch ? nameMatch[1].trim() : '';
  if (!name) return null;

  const nicknameMatch = html.match(/<p[^>]*class="b-content__Nickname"[^>]*>\s*([^<]+?)\s*<\/p>/i) ||
                        html.match(/class="[^"]*nickname[^"]*"[^>]*>\s*"?([^<"]+?)"?\s*</i);
  const nickname = nicknameMatch ? nicknameMatch[1].trim() : '';

  const recordMatch = html.match(/Record:\s*([\d]+)-([\d]+)-?([\d]*)/);
  const wins   = recordMatch ? parseInt(recordMatch[1]) : 0;
  const losses = recordMatch ? parseInt(recordMatch[2]) : 0;
  const draws  = recordMatch ? parseInt(recordMatch[3] || '0') : 0;

  const getStat = (label) => {
    const regex = new RegExp(label + '[:\\s]+([\\d\'.,"\\s]+?)(?:<|\\n|\\r)', 'i');
    const m = html.match(regex);
    return m ? m[1].trim().replace(/\s+/g, ' ') : '';
  };
  const getNum = (label) => {
    const regex = new RegExp(label + '[:\\s]*([\\d.]+)%?', 'i');
    const m = html.match(regex);
    return m ? parseFloat(m[1]) : 0;
  };

  return {
    id: fighterId, url: fighterUrl, name, nickname,
    height: getStat('Height'), weight: getStat('Weight'),
    reach: getStat('Reach'), stance: getStat('STANCE') || getStat('Stance'),
    dob: getStat('DOB'), wins, losses, draws,
    slpm: getNum('SLpM'), str_acc: getNum('Str\\.\\s*Acc\\.'),
    sapm: getNum('SApM'), str_def: getNum('Str\\.\\s*Def'),
    td_avg: getNum('TD\\s*Avg\\.'), td_acc: getNum('TD\\s*Acc\\.'),
    td_def: getNum('TD\\s*Def\\.'), sub_avg: getNum('Sub\\.\\s*Avg\\.')
  };
}

module.exports = {
  refreshEvents,
  scrapeEventMatches,
  scrapeAthlete,
  searchAthlete
};