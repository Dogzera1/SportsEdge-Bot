// shadowMode: tip é gerada e registrada no DB, mas NÃO envia DM (para auditoria de CLV)
// Ativar via <SPORT>_SHADOW=true no env. Usado em novos esportes antes de promoção.
function shadowFor(sport) {
  return process.env[`${sport.toUpperCase()}_SHADOW`] === 'true';
}

const SPORTS = {
  esports: {
    id: 'esports',
    name: 'Esports',
    icon: '🎮',
    // Ativado por default se token existir. Desativa apenas se ESPORTS_ENABLED=false explicitamente.
    enabled: process.env.ESPORTS_ENABLED !== 'false' && !!process.env.TELEGRAM_TOKEN_ESPORTS,
    token: process.env.TELEGRAM_TOKEN_ESPORTS,
    games: ['lol'],
    shadowMode: shadowFor('esports')
  },
  mma: {
    id: 'mma',
    name: 'MMA',
    icon: '🥊',
    enabled: process.env.MMA_ENABLED === 'true' && !!process.env.TELEGRAM_TOKEN_MMA,
    token: process.env.TELEGRAM_TOKEN_MMA,
    games: ['mma'],
    shadowMode: shadowFor('mma')
  },
  tennis: {
    id: 'tennis',
    name: 'Tênis',
    icon: '🎾',
    enabled: process.env.TENNIS_ENABLED === 'true' && !!process.env.TELEGRAM_TOKEN_TENNIS,
    token: process.env.TELEGRAM_TOKEN_TENNIS,
    games: ['tennis'],
    shadowMode: shadowFor('tennis')
  },
  football: {
    id: 'football',
    name: 'Futebol',
    icon: '⚽',
    enabled: process.env.FOOTBALL_ENABLED === 'true' && !!process.env.TELEGRAM_TOKEN_FOOTBALL,
    token: process.env.TELEGRAM_TOKEN_FOOTBALL,
    games: ['football'],
    shadowMode: shadowFor('football')
  },
  darts: {
    id: 'darts',
    name: 'Darts',
    icon: '🎯',
    enabled: process.env.DARTS_ENABLED === 'true' && !!process.env.TELEGRAM_TOKEN_DARTS,
    token: process.env.TELEGRAM_TOKEN_DARTS,
    games: ['darts'],
    // Default em shadow até validar 30 tips. Desligar com DARTS_SHADOW=false.
    shadowMode: process.env.DARTS_SHADOW !== 'false'
  },
  snooker: {
    id: 'snooker',
    name: 'Snooker',
    icon: '🎱',
    // Requer Betfair configurado (BF_APP_KEY/BF_USER/BF_PASS) + token Telegram
    enabled: process.env.SNOOKER_ENABLED === 'true' && !!process.env.TELEGRAM_TOKEN_SNOOKER,
    token: process.env.TELEGRAM_TOKEN_SNOOKER,
    games: ['snooker'],
    // Default em shadow (novo esporte). Desligar com SNOOKER_SHADOW=false.
    shadowMode: process.env.SNOOKER_SHADOW !== 'false'
  }
};

module.exports = {
  SPORTS,
  getSportById: (id) => SPORTS[id] || null,
  getSportByToken: (token) => Object.values(SPORTS).find(s => s.token === token) || null,
  getEnabledSports: () => Object.values(SPORTS).filter(s => s.enabled),
  getTokenToSportMap: () => {
    const map = {};
    for (const sport of Object.values(SPORTS)) {
      if (sport.enabled && sport.token) map[sport.token] = sport.id;
    }
    return map;
  }
};