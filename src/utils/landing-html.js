// Разбор HTML-контента блоков модуля landing без внешних зависимостей.
//
// Блок Bitrix24 приходит готовой вёрсткой, а его манифест перечисляет селекторы
// редактируемых нод (`manifest.nodes`) и карточек (`manifest.cards`). Чтобы
// показать модели текущие значения и подсказать готовый селектор с индексом для
// landing.block.updatenodes, достаточно найти элементы по простым селекторам
// манифеста и вытащить их содержимое — полноценный DOM-парсер ради этого не нужен.

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

// Теги, после закрытия которых текст логично переносить на новую строку.
// `li` сюда не входит: перенос для пункта списка ставится по открывающему тегу.
const BLOCK_TAGS = 'address|article|aside|blockquote|div|dd|dl|dt|figure|footer|h[1-6]|header|main|nav|ol|p|pre|section|table|tr|ul';

const NAMED_ENTITIES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  laquo: '«', raquo: '»', mdash: '—', ndash: '–', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', sbquo: '‚', bdquo: '„',
  bull: '•', middot: '·', deg: '°', times: '×', minus: '−', plusmn: '±',
  copy: '©', reg: '®', trade: '™', euro: '€', rub: '₽', sect: '§',
};

export function decodeEntities(text) {
  return String(text).replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (full, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return full;
      return String.fromCodePoint(code);
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? full : named;
  });
}

// Убирает то, что мешает разбору тегов: комментарии и содержимое script/style.
// Заодно приводит переводы строк к \n — вёрстка блоков приходит с CRLF, а из-за
// уцелевших \r схлопывание пустых строк в htmlToText не срабатывало.
function stripNoise(html) {
  return String(html ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
}

// HTML → читаемый текст с сохранением переносов между блочными элементами.
export function htmlToText(html) {
  const text = stripNoise(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(new RegExp(`</(?:${BLOCK_TAGS})>`, 'gi'), '\n')
    .replace(/<[^>]*>/g, '');

  return decodeEntities(text)
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseAttrs(raw) {
  const attrs = {};
  const re = /([a-zA-Z_:][\w:.-]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let match;
  while ((match = re.exec(raw)) !== null) {
    attrs[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return attrs;
}

function buildElement(open, innerHtml) {
  return {
    tag: open.tag,
    attrs: open.attrs,
    classes: (open.attrs.class || '').split(/\s+/).filter(Boolean),
    id: open.attrs.id || '',
    html: innerHtml,
    start: open.start,
  };
}

// Разбирает вёрстку блока в плоский список элементов в порядке документа.
// Вложенность отслеживается стеком; непарные теги не роняют разбор — стек
// разматывается до ближайшего подходящего открывающего тега.
export function parseElements(html) {
  const source = stripNoise(html);
  const tagRe = /<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  const elements = [];
  const stack = [];
  let match;

  while ((match = tagRe.exec(source)) !== null) {
    const [full, slash, rawName, rawAttrs] = match;
    const tag = rawName.toLowerCase();

    if (slash) {
      let i = stack.length - 1;
      while (i >= 0 && stack[i].tag !== tag) i--;
      if (i < 0) continue; // закрывающий тег без пары — пропускаем
      for (let j = stack.length - 1; j >= i; j--) {
        elements.push(buildElement(stack[j], source.slice(stack[j].innerStart, match.index)));
      }
      stack.length = i;
      continue;
    }

    const attrs = parseAttrs(rawAttrs);
    if (VOID_TAGS.has(tag) || rawAttrs.trimEnd().endsWith('/')) {
      elements.push(buildElement({ tag, attrs, start: match.index }, ''));
    } else {
      stack.push({ tag, attrs, start: match.index, innerStart: match.index + full.length });
    }
  }

  // Незакрытые к концу блока элементы: содержимым считаем всё до конца вёрстки.
  for (const open of stack) {
    elements.push(buildElement(open, source.slice(open.innerStart)));
  }

  return elements.sort((a, b) => a.start - b.start);
}

// Селекторы в манифестах простые: `.class`, `#id`, реже `tag` или `tag.class`.
// У составного селектора берём последний компонент — этого достаточно, чтобы
// найти сами ноды, но совпадение помечается как приблизительное.
export function parseSelector(selector) {
  const parts = String(selector ?? '').trim().split(/\s*>\s*|\s+/).filter(Boolean);
  if (!parts.length) return null;

  const last = parts[parts.length - 1];
  const tag = (last.match(/^[a-zA-Z][\w-]*/) || [''])[0].toLowerCase();
  const classes = [...last.matchAll(/\.([\w-]+)/g)].map(m => m[1]);
  const id = (last.match(/#([\w-]+)/) || [])[1] || '';
  if (!tag && !classes.length && !id) return null;

  return { tag, classes, id, approximate: parts.length > 1 };
}

// Элементы, подходящие под селектор, в порядке документа: их позиция в этом
// массиве и есть индекс `@N`, который понимают методы landing.block.*.
export function matchSelector(elements, selector) {
  const parsed = parseSelector(selector);
  if (!parsed) return [];

  return elements.filter(el =>
    (!parsed.tag || el.tag === parsed.tag) &&
    (!parsed.id || el.id === parsed.id) &&
    parsed.classes.every(cls => el.classes.includes(cls))
  );
}
