/**
 * 调度器：读取项目根目录的 cron.txt，按规则在进程内定时触发刷新
 * 文件里每个非注释行 = 一条规则；只使用前 5 个时间字段，命令字段忽略
 * 规则文件位置固定（不再支持改路径），频率可用 CRON_EXPR / REFRESH_INTERVAL 覆盖
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { nextRun, parseCron } from './cron.js'

const DEFAULT_FILE = fileURLToPath(new URL('../../cron.txt', import.meta.url))

/** 解析 "10m" / "600s" / "15min" / "1h" / "600"(秒) → 秒 */
export function parseDuration(input) {
  const m = String(input).trim().match(/^(\d+)\s*(s|sec|secs|m|min|mins|h|hr|hrs)?$/i)
  if (!m) throw new Error(`无法解析刷新间隔: ${input}（示例：10m / 600s / 1h）`)
  const n = Number(m[1])
  const unit = (m[2] || 'm').toLowerCase()
  return unit.startsWith('h') ? n * 3600 : unit.startsWith('s') ? n : n * 60
}

/** 秒 → cron 表达式（cron 最小粒度 1 分钟，不足一分钟的向上取整并告警） */
export function intervalToCron(seconds, warn = console.warn) {
  let minutes = seconds / 60
  if (minutes < 1) {
    warn(`[cron] REFRESH_INTERVAL=${seconds}s 小于 1 分钟，按 1 分钟处理（cron 最小粒度）`)
    minutes = 1
  }
  if (!Number.isInteger(minutes)) {
    const rounded = Math.ceil(minutes)
    warn(`[cron] REFRESH_INTERVAL 不是整分钟，向上取整为 ${rounded} 分钟`)
    minutes = rounded
  }
  if (minutes < 60) return `*/${minutes} * * * *`
  if (minutes === 60) return '0 * * * *'
  if (minutes % 60 === 0 && minutes < 1440) return `0 */${minutes / 60} * * *`
  if (minutes % 1440 === 0) return `0 0 */${minutes / 1440} * *`
  throw new Error(`REFRESH_INTERVAL 暂时只支持整分钟 / 整小时 / 整天的间隔，收到 ${seconds}s`)
}

/**
 * 规则来源优先级：
 *   1. CRON_DISABLED=1          → 停用自动刷新
 *   2. CRON_EXPR                → 直接用该 cron 表达式
 *   3. REFRESH_INTERVAL         → 换算成 cron 表达式（如 10m → *\/10 * * * *）
 *   4. cron.txt（固定路径）
 */
export function resolveRules() {
  const disabled = ['1', 'true', 'yes', 'on'].includes(String(process.env.CRON_DISABLED || '').toLowerCase())
  if (disabled) return { source: 'CRON_DISABLED', rules: [] }

  const expr = process.env.CRON_EXPR
  if (expr) {
    return {
      source: 'CRON_EXPR',
      rules: [{ line: 0, expression: expr.trim().split(/\s+/).slice(0, 5).join(' '), command: '', cron: parseCron(expr) }],
    }
  }

  const interval = process.env.REFRESH_INTERVAL
  if (interval) {
    const expression = intervalToCron(parseDuration(interval))
    return {
      source: `REFRESH_INTERVAL=${interval} → ${expression}`,
      rules: [{ line: 0, expression, command: '', cron: parseCron(expression) }],
    }
  }

  return { source: 'cron.txt', rules: loadRules() }
}

export function loadRules() {
  const file = DEFAULT_FILE
  const text = fs.readFileSync(file, 'utf8')
  const rules = []
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim()
    if (!line || line.startsWith('#')) return
    const fields = line.split(/\s+/)
    if (fields.length < 5) throw new Error(`cron.txt 第 ${i + 1} 行字段不足: ${line}`)
    const expression = fields.slice(0, 5).join(' ')
    rules.push({
      line: i + 1,
      expression,
      command: fields.slice(5).join(' '),
      cron: parseCron(expression),
      nextRunAt: null,
      timer: null,
      running: false,
    })
  })
  return rules
}

/**
 * 启动调度。handler 收到 rule；返回 Promise 时会被等待（同一规则不重叠执行）。
 */
export function startScheduler({ handler, onLog = console.log } = {}) {
  let rules
  let source = ''
  try {
    const resolved = resolveRules()
    rules = resolved.rules
    source = resolved.source
    onLog(`[cron] 规则来源：${source}`)
  } catch (err) {
    onLog(`[cron] 规则加载失败：${err.message}`)
    return { rules: [], stop() {}, describe: () => [] }
  }

  if (!rules.length) {
    onLog('[cron] 没有有效规则，自动刷新已禁用（仅支持手动刷新）')
    return { rules, source, stop() {}, describe: () => [] }
  }

  const arm = (rule) => {
    const next = nextRun(rule.cron, new Date())
    rule.nextRunAt = next
    if (!next) {
      onLog(`[cron] 规则无效（找不到下次触发时间）：${rule.expression}`)
      return
    }
    const delay = Math.max(1000, next.getTime() - Date.now())
    rule.timer = setTimeout(async () => {
      if (rule.running) {
        onLog(`[cron] 上一轮仍在进行，跳过 ${rule.expression} 本次触发`)
      } else {
        rule.running = true
        const startedAt = Date.now()
        try {
          await handler(rule)
          onLog(`[cron] ${rule.expression} 刷新完成，用时 ${Math.round((Date.now() - startedAt) / 1000)}s`)
        } catch (err) {
          onLog(`[cron] ${rule.expression} 刷新失败：${err?.message || err}`)
        } finally {
          rule.running = false
        }
      }
      arm(rule)
    }, delay)
    if (rule.timer.unref) rule.timer.unref()
  }

  for (const rule of rules) {
    arm(rule)
    onLog(`[cron] 已装载规则 ${rule.expression}（第 ${rule.line} 行），下次 ${fmt(rule.nextRunAt)}`)
  }

  // 监听文件变化：直接改 cron.txt 即可生效，无需重启服务（env 覆盖时不监听）
  let reloading = false
  if (!source.startsWith('cron.txt')) return finish()
  fs.watchFile(DEFAULT_FILE, { interval: 2000 }, () => {
    if (reloading) return
    reloading = true
    setTimeout(() => {
      reloading = false
      for (const r of rules) if (r.timer) clearTimeout(r.timer)
      try {
        const fresh = loadRules()
        rules.length = 0
        rules.push(...fresh)
        for (const rule of rules) arm(rule)
        onLog(`[cron] 规则文件已更新，当前 ${rules.length} 条规则：` +
          (rules.map((r) => `${r.expression} → ${fmt(r.nextRunAt)}`).join('；') || '无（自动刷新已停用）'))
      } catch (err) {
        onLog(`[cron] 规则文件改动无效，保持原规则：${err.message}`)
        for (const rule of rules) arm(rule)
      }
    }, 300)
  })

  return finish()

  function finish() {
    return {
      source,
      rules,
      stop() {
        fs.unwatchFile(DEFAULT_FILE)
        for (const r of rules) if (r.timer) clearTimeout(r.timer)
      },
      describe: () =>
        rules.map((r) => ({ expression: r.expression, nextRunAt: r.nextRunAt?.toISOString() ?? null, source })),
    }
  }
}

function fmt(d) {
  if (!d) return '—'
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}