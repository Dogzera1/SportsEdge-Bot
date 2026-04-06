const SPORTS = {
  esports: {
    id: 'esports',
    name: 'Esports',
    icon: '🎮',
    // Ativado por default se token existir. Desativa apenas se ESPORTS_ENABLED=false explicitamente.
    enabled: process.env.ESPORTS_ENABLED !== 'false' && !!process.env.TELEGRAM_TOKEN_ESPORTS,
    token: process.env.TELEGRAM_TOKEN_ESPORTS,
    games: ['lol']
  },
  mma: {
    id: 'mma',
    name: 'MMA',
    icon: '🥊',
    enabled: process.env.MMA_ENABLED === 'true' && !!process.env.TELEGRAM_TOKEN_MMA,
    token: process.env.TELEGRAM_TOKEN_MMA,
    games: ['mma']
  },
  tennis: {
    id: 'tennis',
    name: 'Tênis',
    icon: '🎾',
    enabled: process.env.TENNIS_ENABLED === 'true' && !!process.env.TELEGRAM_TOKEN_TENNIS,
    token: process.env.TELEGRAM_TOKEN_TENNIS,
    games: ['tennis']
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