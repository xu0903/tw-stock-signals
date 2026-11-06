import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  rocToIso, parseTwseSecurities, parseTpexSecurities, parseTwseExRights, parseTpexExRights,
  parseHolidays, isTradingDay, nextTradingDay, estimatePayDate, withPayDates,
} from './refdata.js'

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'))

test('rocToIso', () => {
  assert.equal(rocToIso('1151021'), '2026-10-21'); assert.equal(rocToIso('115/10/21'), '2026-10-21'); assert.equal(rocToIso('115/1/2'), '2026-01-02')
  assert.throws(() => rocToIso('abc'))
})
test('securities drop non-tradable', () => {
  const t = parseTwseSecurities(fx('twse-stock-day-all.json'))
  assert.deepEqual(t.map((s) => s.symbol), ['0050', '00679B', '00981A', '1101', '2330'])
  assert.deepEqual(t.find((s) => s.symbol === '00679B'), { symbol: '00679B', name: '元大美債20年', market: 'tse', kind: 'bond_etf' })
  const o = parseTpexSecurities(fx('tpex-mainboard-quotes.json'))
  assert.deepEqual(o.map((s) => s.symbol), ['6488', '00679B', '8299']); assert.equal(o[0].market, 'otc')
})
test('ex-rights', () => {
  const t = parseTwseExRights(fx('twse-twt48u.json'))
  assert.equal(t.length, 3)
  assert.deepEqual(t[0], { symbol: '2330', exDate: '2026-10-23', cashPerShare: 5, stockPerShare: 0, payDate: '', payDateEstimated: true })
  assert.equal(t[1].stockPerShare, 0.5); assert.equal(t[2].cashPerShare, 0)
  const o = parseTpexExRights(fx('tpex-exright.json'))
  assert.equal(o[0].exDate, '2026-10-27'); assert.equal(o[0].cashPerShare, 7.5); assert.equal(o[1].stockPerShare, 0.2)
})
test('holidays', () => {
  const h = parseHolidays(fx('twse-holidays.json'))
  assert.equal(isTradingDay('2026-02-12', h), false)
  assert.equal(isTradingDay('2026-01-02', h), true)
  assert.equal(isTradingDay('2026-02-11', h), true)
  assert.equal(isTradingDay('2026-10-24', h), false)   // 週六
  assert.equal(nextTradingDay('2026-02-11', h), '2026-02-13')
})
test('estimatePayDate', () => {
  assert.equal(estimatePayDate('2026-12-16', new Set()), '2027-01-15')
  assert.equal(estimatePayDate('2026-12-16', new Set(['2027-01-15'])), '2027-01-18')   // 遇休市與週末順延
  assert.equal(estimatePayDate('2026-10-17', new Set()), '2026-11-16')
  const [a] = withPayDates([{ symbol: '2330', exDate: '2026-12-16', cashPerShare: 5, stockPerShare: 0, payDate: '', payDateEstimated: true }], new Set())
  assert.equal(a.payDate, '2027-01-15')
})
