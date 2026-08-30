// Шаблоны задач отдают часть полей PHP-сериализованными строками: ACCOMPLICES,
// AUDITORS, RESPONSIBLES приходят как `a:1:{i:0;s:3:"359";}`, а REPLICATE_PARAMS —
// как вложенный массив. REST их не разворачивает, поэтому разбираем сами: формат
// простой и тянуть зависимость ради него не нужно.
//
// Поддерживаются типы, которые реально встречаются в ответах шаблонов:
// N (null), b (bool), i (int), d (float), s (string), a (array).

function parseValue(str, pos) {
  const type = str[pos];

  if (type === 'N') return { value: null, pos: pos + 2 }; // N;

  if (type === 'b' || type === 'i' || type === 'd') {
    const end = str.indexOf(';', pos);
    if (end === -1) throw new Error(`php-unserialize: не найден ';' на позиции ${pos}`);
    const raw = str.slice(pos + 2, end);
    const value = type === 'b' ? raw === '1' : Number(raw);
    return { value, pos: end + 1 };
  }

  if (type === 's') {
    // s:<байт>:"<строка>"; — длина в БАЙТАХ, а не в символах, поэтому кириллицу
    // приходится резать по буферу, иначе смещение уезжает.
    const lenStart = pos + 2;
    const lenEnd = str.indexOf(':', lenStart);
    const byteLen = parseInt(str.slice(lenStart, lenEnd), 10);
    const bodyStart = lenEnd + 2; // пропускаем :"
    const tail = Buffer.from(str.slice(bodyStart), 'utf8');
    const value = tail.subarray(0, byteLen).toString('utf8');
    return { value, pos: bodyStart + value.length + 2 }; // закрывающие ";
  }

  if (type === 'a') {
    const lenStart = pos + 2;
    const lenEnd = str.indexOf(':', lenStart);
    const count = parseInt(str.slice(lenStart, lenEnd), 10);
    let cursor = lenEnd + 2; // пропускаем :{
    const entries = [];
    for (let i = 0; i < count; i++) {
      const key = parseValue(str, cursor);
      const val = parseValue(str, key.pos);
      entries.push([key.value, val.value]);
      cursor = val.pos;
    }
    cursor += 1; // закрывающая }

    // PHP не различает список и словарь: считаем списком массив с ключами 0..n-1.
    const isList = entries.every(([k], i) => k === i);
    const value = isList
      ? entries.map(([, v]) => v)
      : Object.fromEntries(entries.map(([k, v]) => [String(k), v]));
    return { value, pos: cursor };
  }

  throw new Error(`php-unserialize: неизвестный тип '${type}' на позиции ${pos}`);
}

export function phpUnserialize(input) {
  if (typeof input !== 'string' || input === '') return null;
  return parseValue(input, 0).value;
}

// Поля вроде ACCOMPLICES всегда должны быть списком ID. Портал отдаёт их
// сериализованной строкой, обычным массивом или null — приводим к массиву чисел.
export function toIdList(raw) {
  let value = raw;
  if (typeof raw === 'string' && raw.startsWith('a:')) {
    try {
      value = phpUnserialize(raw);
    } catch {
      return [];
    }
  }
  if (!value) return [];
  const list = Array.isArray(value) ? value : Object.values(value);
  return list.map(Number).filter(n => Number.isFinite(n) && n > 0);
}

// REPLICATE_PARAMS приходит сериализованным объектом (или null).
export function toObject(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  if (typeof raw === 'string' && raw.startsWith('a:')) {
    try {
      return phpUnserialize(raw);
    } catch {
      return null;
    }
  }
  return null;
}
