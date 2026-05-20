// shadowMode: tip é gerada e registrada no DB, mas NÃO envia DM (para auditoria de CLV)
// Ativar via <SPORT>_SHADOW=true no env. Usado em novos esportes antes de promoção.
function shadowFor(sport) {
  return process.env[`${sport.toUpperCase()}_SHADOW`] === 'true';
}

// 2026-05-20: TIPS_UNIFIED_TOKEN — bot único pra todos sports. Quando setado,
// faz fallback pra todos sports que não têm TELEGRAM_TOKEN_<SPORT> próprio.
// Caso: user adiciona 1 bot no grupo Telegram. Não quer adicionar 7+ bots (um
// por sport). Setar TIPS_UNIFIED_TOKEN = token desse bot único → todos sports
// dispatcham via esse bot. Per-sport token ainda override (precedence).
const _UNIFIED = process.env.TIPS_UNIFIED_TOKEN || '';

function _resolveToken(perSportEnv, ...fallbackEnvs) {
  return process.env[perSportEnv] || fallbackEnvs.map(e => process.env[e]).find(Boolean) || _UNIFIED || '';
}

const SPORTS = {
  esports: {
    id: 'esports',
    name: 'Esports',
    icon: '🎮',
    // Ativado por default se token existir. Desativa apenas se ESPORTS_ENABLED=false explicitamente.
    enabled: process.env.ESPORTS_ENABLED !== 'false' && !!_resolveToken('TELEGRAM_TOKEN_ESPORTS'),
    token: _resolveToken('TELEGRAM_TOKEN_ESPORTS'),
    // 2026-05-20: dota2 adicionado. Tips reais dispatcham com sport='dota2'
    // (game id) — antes só 'lol' aqui significava que dota2 nunca era incluído
    // em sport_prefs de groups subscribed via TELEGRAM_GROUP_CHAT_IDS_ALL.
    games: ['lol', 'dota2'],
    shadowMode: shadowFor('esports')
  },
  mma: {
    id: 'mma',
    name: 'MMA',
    icon: '🥊',
    enabled: process.env.MMA_ENABLED === 'true' && !!_resolveToken('TELEGRAM_TOKEN_MMA'),
    token: _resolveToken('TELEGRAM_TOKEN_MMA'),
    games: ['mma'],
    shadowMode: shadowFor('mma')
  },
  tennis: {
    id: 'tennis',
    name: 'Tênis',
    icon: '🎾',
    enabled: process.env.TENNIS_ENABLED === 'true' && !!_resolveToken('TELEGRAM_TOKEN_TENNIS'),
    token: _resolveToken('TELEGRAM_TOKEN_TENNIS'),
    games: ['tennis'],
    shadowMode: shadowFor('tennis')
  },
  football: {
    id: 'football',
    name: 'Futebol',
    icon: '⚽',
    enabled: process.env.FOOTBALL_ENABLED === 'true' && !!_resolveToken('TELEGRAM_TOKEN_FOOTBALL'),
    token: _resolveToken('TELEGRAM_TOKEN_FOOTBALL'),
    games: ['football'],
    shadowMode: shadowFor('football')
  },
  darts: {
    id: 'darts',
    name: 'Darts',
    icon: '🎯',
    enabled: process.env.DARTS_ENABLED === 'true' && !!_resolveToken('TELEGRAM_TOKEN_DARTS'),
    token: _resolveToken('TELEGRAM_TOKEN_DARTS'),
    games: ['darts'],
    // 2026-05-20: DEFAULT promovido pra REAL (user-authorized). Override
    // DARTS_SHADOW=true volta pra shadow. Auto-shadow cron (bot.js:5750) flipa
    // shadowMode=true automaticamente se CLV negativo persistir. Histórico:
    // 2026-05-12 shadow ON por ROI real -100% n=3 (sample minúsculo).
    shadowMode: process.env.DARTS_SHADOW === 'true'
  },
  snooker: {
    id: 'snooker',
    name: 'Snooker',
    icon: '🎱',
    // Fonte de odds: Pinnacle guest API (funciona do BR, sem auth).
    // Betfair Exchange bloqueia IPs brasileiros, por isso não é usado.
    enabled: process.env.SNOOKER_ENABLED === 'true' && !!_resolveToken('TELEGRAM_TOKEN_SNOOKER'),
    token: _resolveToken('TELEGRAM_TOKEN_SNOOKER'),
    games: ['snooker'],
    // GRADUADO: enrichment CueTracker (win rate temporada atual) fornece 2º fator do ML.
    // Combinado com implied odds Pinnacle, gera edge calculável.
    // Voltar pra shadow: SNOOKER_SHADOW=true
    shadowMode: process.env.SNOOKER_SHADOW === 'true'
  },
  cs: {
    id: 'cs',
    name: 'Counter-Strike 2',
    icon: '🔫',
    // Graduado (abr/2026). Pra voltar pra shadow: CS_SHADOW=true
    enabled: process.env.CS_ENABLED === 'true' && !!_resolveToken('TELEGRAM_TOKEN_CS'),
    token: _resolveToken('TELEGRAM_TOKEN_CS'),
    games: ['cs'],
    shadowMode: process.env.CS_SHADOW === 'true'
  },
  valorant: {
    id: 'valorant',
    name: 'Valorant',
    icon: '🎯',
    // Graduado (abr/2026). Compartilha o bot Telegram do CS (TELEGRAM_TOKEN_CS)
    // por padrão. Pra voltar pra shadow: VALORANT_SHADOW=true
    enabled: process.env.VALORANT_ENABLED === 'true' && !!_resolveToken('TELEGRAM_TOKEN_VALORANT', 'TELEGRAM_TOKEN_CS'),
    token: _resolveToken('TELEGRAM_TOKEN_VALORANT', 'TELEGRAM_TOKEN_CS'),
    games: ['valorant'],
    shadowMode: process.env.VALORANT_SHADOW === 'true'
  },
  tabletennis: {
    id: 'tabletennis',
    name: 'Tênis de Mesa',
    icon: '🏓',
    // Novo esporte (abr/2026). Começa em shadow para validar calibração antes de enviar DMs.
    // Graduação: setar TABLETENNIS_SHADOW=false quando CLV médio positivo por ~30 tips.
    enabled: process.env.TABLETENNIS_ENABLED === 'true' && !!_resolveToken('TELEGRAM_TOKEN_TABLETENNIS'),
    token: _resolveToken('TELEGRAM_TOKEN_TABLETENNIS'),
    games: ['tabletennis'],
    // Default EM shadow até validar. Sem DM, só registra no DB.
    shadowMode: process.env.TABLETENNIS_SHADOW !== 'false'
  },
  basket: {
    id: 'basket',
    name: 'Basquete (NBA)',
    icon: '🏀',
    // Novo esporte (mai/2026). Sources: ESPN scoreboard (NBA primário, futuro: Euroleague)
    // + The Odds API basketball_nba. Modelo: Elo + Pinnacle implied. ML markets only fase 1.
    // Sempre em shadow até CLV médio positivo + n≥30 settled. Sem DM (registra DB).
    // Default ENABLED=true porque shadow protege de DM acidental. Disable: BASKET_ENABLED=false.
    enabled: process.env.BASKET_ENABLED !== 'false' && !!_resolveToken('TELEGRAM_TOKEN_BASKET', 'TELEGRAM_TOKEN_FOOTBALL'),
    token: _resolveToken('TELEGRAM_TOKEN_BASKET', 'TELEGRAM_TOKEN_FOOTBALL'),
    games: ['basket'],
    // Default EM shadow. Para promover quando validado: BASKET_SHADOW=false
    shadowMode: process.env.BASKET_SHADOW !== 'false'
  }
};

// Whitelist por liga pra promote seletivo dentro de sport em shadowMode.
// Caso de uso (2026-05-12, valorant): sport global em VALORANT_SHADOW=true mas
// Champions Tour Americas tem shadow ROI +48% n=21 calib gap underestima (+10pp)
// — promove só essa liga pra real, resto continua shadow.
//
// Env hierarchy: <SPORT>_REAL_LEAGUES="Champions Tour: Americas,Outra Liga"
// Match: substring case-insensitive (resolve naming drift Pinnacle vs PandaScore).
// Vazio/unset = whitelist desativada = todas as ligas seguem shadowMode global.
function isLeagueRealOverride(sport, league) {
  if (!sport || !league) return false;
  const envKey = `${String(sport).toUpperCase()}_REAL_LEAGUES`;
  const raw = String(process.env[envKey] || '').trim();
  if (!raw) return false;
  const needles = raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!needles.length) return false;
  const hay = String(league).toLowerCase();
  return needles.some(n => hay.includes(n));
}

module.exports = {
  SPORTS,
  getSportById: (id) => SPORTS[id] || null,
  getSportByToken: (token) => Object.values(SPORTS).find(s => s.token === token) || null,
  getEnabledSports: () => Object.values(SPORTS).filter(s => s.enabled),
  isLeagueRealOverride,
  getTokenToSportMap: () => {
    const map = {};
    for (const sport of Object.values(SPORTS)) {
      if (sport.enabled && sport.token) map[sport.token] = sport.id;
    }
    return map;
  }
};
