const SPORTS = {
  esports: {
    id: 'esports',
    name: 'Esports',
    icon: '🎮',
    enabled: process.env.ESPORTS_ENABLED === 'true',
    token: process.env.TELEGRAM_TOKEN_ESPORTS,
    games: ['lol', 'dota']
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