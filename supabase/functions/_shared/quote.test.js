import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseMis, isStale, FakeQuoteSource, MisQuoteSource } from './quote.js'

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'))

test('parseMis lot: 張 → 股', () => {
  const b = parseMis(fx('mis-lot.json'), 'lot').get('2330')
  assert.deepEqual(b.asks[0], { price: 2420, qty: 1064000 })
  assert.deepEqual(b.bids[0], { price: 2415, qty: 812000 })
  assert.equal(b.asks.length, 5); assert.equal(b.limitUp, 2645); assert.equal(b.limitDown, 2165); assert.equal(b.ref, 2405); assert.equal(b.last, 2420)
  assert.equal(b.time, '2026-10-21T05:00:00.000Z')
})
test('parseMis limit up: no asks', () => {
  const b = parseMis(fx('mis-lot.json'), 'lot').get('6488')
  assert.deepEqual(b.asks, []); assert.equal(b.bids.length, 5)
})
test('parseMis odd: 股', () => {
  const b = parseMis(fx('mis-odd.json'), 'odd').get('2330')
  assert.deepEqual(b.asks[0], { price: 2420, qty: 400 }); assert.equal(b.session, 'odd')
})
test('parseMis drops "-" and zero levels', () => {
  const m = parseMis({ msgArray: [{ c: '1101', a: '-', f: '-', b: '30.0000_0.0000_29.9000_', g: '5_3_0_', z: '-', u: '33', w: '27', y: '30', tlong: '0' }] }, 'lot').get('1101')
  assert.deepEqual(m.asks, []); assert.deepEqual(m.bids, [{ price: 30, qty: 5000 }]); assert.equal(m.last, null)
})
test('isStale', () => {
  const b = { time: '2026-10-21T05:00:00.000Z' }
  assert.equal(isStale(b, new Date('2026-10-21T05:00:31Z')), true)
  assert.equal(isStale(b, new Date('2026-10-21T05:00:29Z')), false)
})
test('FakeQuoteSource returns copies', async () => {
  const q = new FakeQuoteSource(parseMis(fx('mis-lot.json'), 'lot'))
  const m = await q.getBooks([{ symbol: '2330', market: 'tse' }], 'lot')
  m.get('2330').asks.length = 0
  assert.equal((await q.getBooks([{ symbol: '2330', market: 'tse' }], 'lot')).get('2330').asks.length, 5)
  assert.equal((await q.getBooks([{ symbol: '2330', market: 'tse' }], 'odd')).size, 0)
})
test('MisQuoteSource batches 50 and builds ex_ch', async () => {
  const urls = []
  const fake = async (u) => { urls.push(u); return { ok: true, json: async () => fx('mis-lot.json') } }
  const items = Array.from({ length: 51 }, (_, i) => ({ symbol: String(1101 + i), market: i ? 'tse' : 'otc' }))
  const m = await new MisQuoteSource(fake).getBooks(items, 'lot')
  assert.equal(urls.length, 2); assert.ok(urls[0].includes('getStockInfo.jsp')); assert.ok(decodeURIComponent(urls[0]).includes('otc_1101.tw|tse_1102.tw'))
  assert.ok(m.has('2330'))
})
