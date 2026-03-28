const SPORTS = {
  mma: {
    id: 'mma',
    name: 'MMA',
    icon: '🥊',
    enabled: process.env.MMA_ENABLED !== 'false',
    token: process.env.TELEGRAM_TOKEN_MMA,
    sportKey: 'mma_mixed_martial_arts'
  },
  esports: {
    id: 'esports',
    name: 'Esports',
    icon: '🎮',
    enabled: process.env.ESPORTS_ENABLED !== 'false',
    token: process.env.TELEGRAM_TOKEN_ESPORTS,
    games: ['lol', 'dota']
  },
  tennis: {
    id: 'tennis',
    name: 'Tênis',
    icon: '🎾',
    enabled: process.env.TENNIS_ENABLED === 'true',
    token: process.env.TELEGRAM_TOKEN_TENNIS,
    sportKey: 'tennis'
  }
};

module.exports = {
  SPORTS,
  getSportById: (id) => SPORTS[id] || null,
  getEnabledSports: () => Object.values(SPORTS).filter(s => s.enabled),
  getTokenToSportMap: () => {
    const map = {};
    for (const sport of Object.values(SPORTS)) {
      if (sport.enabled && sport.token) map[sport.token] = sport.id;
    }
    return map;
  }
};