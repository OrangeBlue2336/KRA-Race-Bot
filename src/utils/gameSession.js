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
// onExpire: ttlMs로 세션이 자동 만료될 때 호출되는 콜백(비동기 가능). 예를 들어 베팅액을
//   gameHoldService로 보관 중이었다면, TTL 만료(=유저의 게임 방치)도 "게임 종료"이므로
//   여기서 releaseGameHold(session.id)를 호출해 다음 봇 재시작 때 잘못 환불되지 않게 한다.
function createGameSessionStore(ttlMs, keyField, onExpire) {
  const sessions = new Map();
  const byKey = keyField ? new Map() : null;

  function add(session) {
    sessions.set(session.id, session);
    if (byKey) byKey.set(session[keyField], session.id);
    if (ttlMs) {
      setTimeout(() => {
        if (sessions.get(session.id) === session) {
          remove(session.id);
          if (onExpire) {
            Promise.resolve(onExpire(session)).catch((error) => console.error('[gameSession] onExpire 처리 실패', error));
          }
        }
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
