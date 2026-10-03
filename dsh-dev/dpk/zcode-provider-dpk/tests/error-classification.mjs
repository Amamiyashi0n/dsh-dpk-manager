/**
 * 失败分类测试:额度耗尽必须成为 `QUOTA`,而不是可重试的 `RATE_LIMIT`。
 *
 * 官方 `open.bigmodel.cn` 把**终态欠费**发成 HTTP 429,业务码放在 body 里:
 *   实测 `429 {"error":{"code":"1113","message":"余额不足或无可用资源包,请充值。"}}`
 * 只看状态码会把它降级成限流,于是 DSH 的欠费提醒(失败行的额度文案 + 全局
 * `shell.quota-notice`)永远不触发——这正是"没额度却没有正确提醒"的根因。
 *
 * 第二组覆盖流内错误:官方会在 200 的 SSE 里下发 `{type:'error',…}`。该分支曾经是
 * 死代码(被类型白名单先 `continue` 掉),失败原因被吞掉、只剩误导性的 STREAM_CLOSED。
 *
 * 用法:node tests/error-classification.mjs(需先 npm run build)
 */
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const { failureCode, failureFrom, translateZcodeEvents } =
  await import(pathToFileURL(join(here, '..', 'lib', 'index.js')).href)

const failures = []
let passed = 0
function check(label, ok, detail = '') {
  if (ok) { passed += 1; console.log(`PASS  ${label}`) }
  else { failures.push(`${label}${detail ? ` — ${detail}` : ''}`); console.log(`FAIL  ${label}  ${detail}`) }
}

/** 官方欠费的原始响应体(逐字取自权益差异分析报告的实测记录)。 */
const BIGMODEL_QUOTA_BODY = '{"error":{"code":"1113","message":"余额不足或无可用资源包,请充值。"}}'

// ---- 1. HTTP 失败:额度与限流的区分 ----
{
  const quota = failureFrom(429, JSON.parse(BIGMODEL_QUOTA_BODY), 'fallback')
  check('额度:429 + 业务码 1113 + 中文欠费消息 → QUOTA', quota.code === 'QUOTA', quota.code)
  check('额度:服务端消息被保留(用户看得见原因)',
    quota.message === '余额不足或无可用资源包,请充值。', quota.message)

  const domestic = failureFrom(429, { code: 1113, msg: '余额不足' }, 'fallback')
  check('额度:国内 {code,msg} 形态(数字业务码)同样识别', domestic.code === 'QUOTA', domestic.code)
  check('额度:消息取 msg 字段', domestic.message === '余额不足', domestic.message)

  const wording = failureFrom(429, { message: '当前套餐额度已用尽' }, 'fallback')
  check('额度:无已知业务码但中文措辞命中 → QUOTA', wording.code === 'QUOTA', wording.code)

  const remittance = failureFrom(429, { message: 'insufficient balance' }, 'fallback')
  check('额度:英文措辞走 DSH 共享判定 → QUOTA', remittance.code === 'QUOTA', remittance.code)

  const billing = failureFrom(402, {}, 'payment required')
  check('额度:HTTP 402 → QUOTA', billing.code === 'QUOTA', billing.code)

  const rate = failureFrom(429, { message: 'rate limit reached' }, 'fallback')
  check('限流:纯 429(无欠费线索)仍是 RATE_LIMIT', rate.code === 'RATE_LIMIT', rate.code)

  const rateTyped = failureFrom(429, { error: { type: 'rate_limit_error', message: 'too many requests' } }, 'fallback')
  check('限流:rate_limit_error 类型保持 RATE_LIMIT', rateTyped.code === 'RATE_LIMIT', rateTyped.code)

  const auth = failureFrom(401, {}, 'unauthorized')
  check('鉴权:401 → AUTH', auth.code === 'AUTH', auth.code)

  const server = failureFrom(503, {}, 'upstream down')
  check('服务端:503 → SERVER', server.code === 'SERVER', server.code)

  const unknown = failureFrom(418, {}, "I'm a teapot")
  check('未分类:落到 HTTP_<status>', unknown.code === 'HTTP_418', unknown.code)

  const nonJson = failureFrom(500, undefined, 'plain text body')
  check('非 JSON 载荷:原文即消息', nonJson.message === 'plain text body', nonJson.message)
}

// ---- 2. 流内错误:必须被抛出并分类,不能被吞掉 ----
{
  async function drain(events) {
    const chunks = []
    for await (const chunk of translateZcodeEvents(events)) chunks.push(chunk)
    return chunks
  }

  let inBand
  try {
    await drain([{ type: 'error', error: { code: '1113', message: '余额不足或无可用资源包,请充值。' } }])
  } catch (error) { inBand = error }
  check('流内额度错误:被抛出且分类为 QUOTA(而非 STREAM_CLOSED)',
    inBand?.code === 'QUOTA', String(inBand?.code ?? inBand))
  check('流内额度错误:消息来自 error 事件',
    inBand?.message === '余额不足或无可用资源包,请充值。', String(inBand?.message))

  let inBandServer
  try {
    await drain([{ type: 'error', error: { message: 'internal error' } }])
  } catch (error) { inBandServer = error }
  check('流内一般错误:无状态码时落 SERVER', inBandServer?.code === 'SERVER', String(inBandServer?.code))

  let inBandBare
  try {
    await drain([{ type: 'error' }])
  } catch (error) { inBandBare = error }
  check('流内裸 error 事件:仍抛错而非静默结束',
    inBandBare !== undefined && typeof inBandBare.message === 'string' && inBandBare.message.includes('stream error'),
    String(inBandBare?.message))

  // 正常路径不受影响:错误事件之外的类型仍按原语义翻译。
  let truncated
  try {
    await drain([{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } }])
  } catch (error) { truncated = error }
  check('回归:没有 message_start 的普通事件仍报 MALFORMED_RESPONSE',
    truncated?.code === 'MALFORMED_RESPONSE', String(truncated?.code ?? truncated))

  const ok = await drain([
    { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ])
  check('回归:正常流仍翻译出文本与结束块',
    ok.some((chunk) => chunk.type === 'text-delta' && chunk.text === 'hi')
    && ok.some((chunk) => chunk.type === 'finish'),
    JSON.stringify(ok))
}

// ---- 3. 分类器可直接调用(便于以后扩展业务码) ----
check('分类器:额度码集合按业务码命中',
  failureCode(429, '', '1113', '') === 'QUOTA')
check('分类器:无状态码且无线索时退化 SERVER',
  failureCode(undefined, '', '', '') === 'SERVER')

console.log(`\n${passed}/${passed + failures.length} 项通过`)
if (failures.length) {
  console.error(`\n失败项:\n- ${failures.join('\n- ')}`)
  process.exit(1)
}
