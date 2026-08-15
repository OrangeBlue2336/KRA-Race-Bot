function createGameId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function createCooldownManager({ autoCleanup = false } = {}) {
  const cooldowns = new Map();

  function getUntil(userId) {
    return cooldowns.get(String(userId)) || 0;
  }

  function getRemainingSeconds(userId) {
    const key = String(userId);
    const until = getUntil(key);
    if (!until) return 0;
    if (until <= Date.now()) {
      cooldowns.delete(key);
      return 0;
    }
    return Math.ceil((until - Date.now()) / 1000);
  }

  function set(userId, seconds) {
    const key = String(userId);
    const until = Date.now() + seconds * 1000;
    cooldowns.set(key, until);
    if (autoCleanup) {
      setTimeout(() => {
        if (cooldowns.get(key) === until) cooldowns.delete(key);
      }, seconds * 1000 + 100);
    }
  }

  return { getUntil, getRemainingSeconds, set };
}

function createGameSessionStore(ttlMs) {
  const sessions = new Map();

  function add(session) {
    sessions.set(session.id, session);
    if (ttlMs) {
      setTimeout(() => {
        if (sessions.get(session.id) === session) sessions.delete(session.id);
      }, ttlMs);
    }
  }

  return {
    add,
    get: (id) => sessions.get(id),
    delete: (id) => sessions.delete(id),
  };
}

module.exports = {
  createGameId,
  createCooldownManager,
  createGameSessionStore,
};
