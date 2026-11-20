// Self-check for the riskiest pure logic in the userscript. Run: node test.js
// The script is one browser-only file, so this cuts the needed functions out of it by their markers.
const fs = require('fs');
const assert = require('assert');
const src = fs.readFileSync(__dirname + '/googlephotos-toolkit.user.js', 'utf8');
const between = (start, end) => {
  const a = src.indexOf(start), b = src.indexOf(end, a + start.length);
  assert(a >= 0 && b > a, `marker not found: ${start}`);
  return src.slice(a, b);
};

// 1. Date-from-filename parser: it rewrites "date taken" on many photos at once.
const parser = between('/*\n   * Finds the first plausible date', '//  High-level API operations');
const { parseDateFromFilename, formatParsedDate } = new Function(`${parser}; return { parseDateFromFilename, formatParsedDate };`)();
const cases = {
  'IMG_20230515_143022.jpg': '2023-05-15 14:30:22',
  'PXL_20230105_000512345.jpg': '2023-01-05 00:05:12', // Pixel: hour 00 + milliseconds
  'Screenshot_2023-05-15-14-30-22.png': '2023-05-15 14:30:22',
  '2023-05-15 143022.jpg': '2023-05-15 14:30:22',
  '2023-05-15 00-30-00.jpg': '2023-05-15 00:30:00', // 3.3.0 dropped the minutes
  '20230515143022.jpg': '2023-05-15 14:30:22',
  'IMG-20230515-WA0001.jpg': '2023-05-15 00:00:00',
  '2023_05_15_photo.jpg': '2023-05-15 00:00:00',
  'IMG_20230312_023000.jpg': '2023-03-12 02:30:00', // inside a US DST gap: must not be rejected
  'folder/sub/IMG_20200229_120000.jpg': '2020-02-29 12:00:00', // leap day, path stripped
};
for (const [name, want] of Object.entries(cases)) {
  const got = parseDateFromFilename(name);
  assert.strictEqual(got && formatParsedDate(got), want, name);
}
for (const name of ['holiday.jpg', 'IMG_20231345_120000.jpg', 'IMG_20230230.jpg']) {
  assert.strictEqual(parseDateFromFilename(name), null, `${name} should not parse`);
}

// 2. Duplicate Finder trash list: a confirmed group with nothing kept must never trash every copy.
const toTrashSrc = src.split('\n').find((l) => l.trim().startsWith('function toTrash()'));
const toTrash = (S) => new Function('S', `${toTrashSrc}; return toTrash();`)(S);
const items = [{ k: 'a' }, { k: 'b' }, { k: 'c' }];
const g = (status, keep) => ({ ids: [0, 1, 2], status, keep: new Set(keep) });
assert.deepStrictEqual(toTrash({ items, groups: [g('dup', [0])] }).map((x) => x.it.k), ['b', 'c']);
assert.deepStrictEqual(toTrash({ items, groups: [g('dup', [])] }), [], 'empty keep must trash nothing');
assert.deepStrictEqual(toTrash({ items, groups: [g('open', [0]), g('notdup', [0])] }), []);

// 3. Paged reads: a failed page must stop the run, not return a partial list
//    (a partial "Exclude Albums" list would let Move to Trash hit photos that are in albums).
const getAllItemsSrc = between('async getAllItems(', 'async getAllAlbums()');
const Utils = new Function('log', `return class { constructor() { this.core = { isProcessRunning: true }; this.api = {}; } ${getAllItemsSrc} }`)(() => {});
const pages = async (...args) => {
  const pageId = args[args.length - 1];
  if (!pageId) return { items: [{ dedupKey: 'a' }], nextPageId: 'p2' };
  throw new Error('HTTP 429');
};

(async () => {
  await assert.rejects(new Utils().getAllItems(pages), /HTTP 429/, 'a failed page must throw, not return page 1 alone');
  console.log(`ok: ${Object.keys(cases).length + 3} date cases, 3 trash-list cases, 1 paged-read case`);
})().catch((e) => { console.error(e); process.exit(1); });
