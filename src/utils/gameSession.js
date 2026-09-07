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

// ttlMs: 세션 자동 만료 시간(ms). 없으면 만료 없음(직접 delete 필요).
// keyField: 지정하면 session[keyField] 값으로도 조회 가능한 보조 인덱스를 함께 유지한다.
//   예: createGameSessionStore(undefined, 'discordId')는 "이 유저가 진행 중인 게임이 있는가"를
//   getByKey(discordId)로 바로 확인할 수 있게 해준다 — 게임 파일에서 별도 Map을 새로 만들지 않아도 됨.
function createGameSessionStore(ttlMs, keyField) {
  const sessions = new Map();
  const byKey = keyField ? new Map() : null;

  function add(session) {
    sessions.set(session.id, session);
    if (byKey) byKey.set(session[keyField], session.id);
    if (ttlMs) {
      setTimeout(() => {
        if (sessions.get(session.id) === session) remove(session.id);
      }, ttlMs);
    }
  }

  function remove(id) {
    const session = sessions.get(id);
    const removed = sessions.delete(id);
    if (byKey && session && byKey.get(session[keyField]) === id) byKey.delete(session[keyField]);
    return removed;
  }

  return {
    add,
    get: (id) => sessions.get(id),
    delete: remove,
    getByKey: byKey ? (key) => sessions.get(byKey.get(key)) : undefined,
  };
}

module.exports = {
  createGameId,
  createCooldownManager,
  createGameSessionStore,
};
