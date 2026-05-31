const { BET_TYPE_BY_NAME } = require('../config');

function splitNumbers(value) {
  return String(value || '')
    .split(/[-,]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map(String);
}

function sameOrdered(left, right) {
  return left.length === right.length && left.every((value, index) => String(value) === String(right[index]));
}

function sameUnordered(left, right) {
  if (left.length !== right.length) return false;
  return [...left].map(String).sort((a, b) => Number(a) - Number(b)).join(',')
    === [...right].map(String).sort((a, b) => Number(a) - Number(b)).join(',');
}

function parseHorseInput(raw) {
  const value = String(raw || '').trim();
  if (value.toLowerCase() === 'test') {
    return {
      isTest: true,
      horses: ['test'],
      formatErrors: [],
    };
  }

  const parts = value.split(',').map((part) => part.trim());
  const horses = parts.filter(Boolean);
  const formatErrors = [];

  if (horses.length === 0) {
    formatErrors.push('마번을 입력해주세요. 예: 3 또는 3,5');
  }

  if (parts.some((part) => part === '')) {
    formatErrors.push('마번 사이에 빈 값이 있습니다. 쉼표 앞뒤를 확인해주세요.');
  }

  const invalid = horses.filter((horse) => !/^\d+$/.test(horse));
  if (invalid.length > 0) {
    formatErrors.push(`마번은 숫자만 입력할 수 있습니다: ${invalid.join(', ')}`);
  }

  if (new Set(horses).size !== horses.length) {
    formatErrors.push('중복된 마번이 있습니다.');
  }

  return {
    isTest: false,
    horses,
    formatErrors,
  };
}

function validateHorseCount(betTypeName, horses, isTest) {
  if (isTest) return null;

  const betType = BET_TYPE_BY_NAME[betTypeName];
  if (!betType) return '알 수 없는 승식입니다.';
  if (horses.length !== betType.horseCount) {
    return `${betTypeName}은 마번 ${betType.horseCount}개가 필요합니다. 현재 ${horses.length}개입니다.`;
  }
  return null;
}

function validateEntryNumbers(horses, entries, isTest) {
  if (isTest) return [];

  const validNumbers = entries.map((entry) => String(entry.chulNo)).filter(Boolean);
  if (validNumbers.length === 0) {
    return ['출전마 목록이 비어 있어 마번 유효성을 확인할 수 없습니다.'];
  }

  const maxNumber = Math.max(...validNumbers.map(Number));
  const invalidNumbers = horses.filter((horse) => !validNumbers.includes(String(horse)));
  if (invalidNumbers.length === 0) return [];

  return [
    `출전하지 않는 마번입니다: ${invalidNumbers.join(', ')}`,
    `해당 경주의 최대 마번은 ${maxNumber}번이며, 출전마는 ${validNumbers.join(', ')}번입니다.`,
  ];
}

function parseAmount(raw) {
  const amount = Number(String(raw || '').replace(/,/g, '').trim());
  if (!Number.isInteger(amount)) return null;
  return amount;
}

function findPairOdds(summaryNumbers, summaryOdds, horses, ordered) {
  const numberGroups = String(summaryNumbers || '')
    .split(',')
    .map(splitNumbers)
    .filter((numbers) => numbers.length > 0);
  const oddsList = String(summaryOdds || '')
    .split(',')
    .map((odds) => Number(odds.trim()));

  const index = numberGroups.findIndex((numbers) => (
    ordered ? sameOrdered(numbers, horses) : sameUnordered(numbers, horses)
  ));

  if (index === -1) return 0;
  return Number.isFinite(oddsList[index]) ? oddsList[index] : 0;
}

function evaluateTicket(ticket, top3, summary) {
  const selected = ticket.horses.map(String);
  const topNumbers = top3.map((result) => String(result.chulNo));
  const dusu = Number(ticket.dusu || topNumbers.length);

  if (ticket.isTest) {
    const testOddsMap = {
    '단승식':   Number(summary?.winOdds || 0),
    '연승식':   Number(String(summary?.plcOdds || '0').split('-')[0] || 0),
    '복연승식': Number(String(summary?.qplOdds || '0').split(',')[0] || 0),
    '복승식':   Number(summary?.qnlOdds || 0),
    '쌍승식':   Number(summary?.exaOdds || 0),
    '삼복승식': Number(summary?.tlaOdds || 0),
    '삼쌍승식': Number(summary?.triOdds || 0),
  };
  return {
    won: true,
    odds: testOddsMap[ticket.betType] || 1,
    winningNumbers: topNumbers.slice(0, Math.min(3, topNumbers.length)),
    note: '테스트 입력으로 적중 처리되었습니다.',
  };
}

  switch (ticket.betType) {
    case '단승식': {
      const winningNumbers = splitNumbers(summary?.winChulNo || topNumbers[0]);
      return {
        won: sameOrdered(selected, winningNumbers),
        odds: Number(summary?.winOdds || top3[0]?.winOdds || 0),
        winningNumbers,
      };
    }

    case '연승식': {
      const placeLimit = dusu <= 7 ? 2 : 3;
      const placeNumbers = splitNumbers(summary?.plcChulNo || topNumbers.slice(0, placeLimit).join('-'));
      const placeOdds = String(summary?.plcOdds || '')
        .split('-')
        .map((odds) => Number(odds.trim()));
      const selectedIndex = placeNumbers.findIndex((number) => number === selected[0]);
      const fallbackOdds = top3.find((result) => String(result.chulNo) === selected[0])?.plcOdds;

      return {
        won: selectedIndex !== -1 && selectedIndex < placeLimit,
        odds: Number(placeOdds[selectedIndex] || fallbackOdds || 0),
        winningNumbers: placeNumbers.slice(0, placeLimit),
      };
    }

    case '복연승식': {
      const odds = findPairOdds(summary?.qplChulNo, summary?.qplOdds, selected, false);
      const winningNumbers = topNumbers.slice(0, 3);
      return {
        won: selected.every((horse) => winningNumbers.includes(horse)),
        odds,
        winningNumbers,
      };
    }

    case '복승식': {
      const winningNumbers = splitNumbers(summary?.qnlChulNo || topNumbers.slice(0, 2).join('-'));
      return {
        won: sameUnordered(selected, winningNumbers),
        odds: Number(summary?.qnlOdds || 0),
        winningNumbers,
      };
    }

    case '쌍승식': {
      const winningNumbers = splitNumbers(summary?.exaChulNo || topNumbers.slice(0, 2).join('-'));
      return {
        won: sameOrdered(selected, winningNumbers),
        odds: Number(summary?.exaOdds || 0),
        winningNumbers,
      };
    }

    case '삼복승식': {
      const winningNumbers = splitNumbers(summary?.tlaChulNo || topNumbers.slice(0, 3).join('-'));
      return {
        won: sameUnordered(selected, winningNumbers),
        odds: Number(summary?.tlaOdds || 0),
        winningNumbers,
      };
    }

    case '삼쌍승식': {
      const winningNumbers = splitNumbers(summary?.triChulNo || topNumbers.slice(0, 3).join('-'));
      return {
        won: sameOrdered(selected, winningNumbers),
        odds: Number(summary?.triOdds || 0),
        winningNumbers,
      };
    }

    default:
      return {
        won: false,
        odds: 0,
        winningNumbers: topNumbers.slice(0, 3),
      };
  }
}

module.exports = {
  parseHorseInput,
  validateHorseCount,
  validateEntryNumbers,
  parseAmount,
  evaluateTicket,
  splitNumbers,
};
