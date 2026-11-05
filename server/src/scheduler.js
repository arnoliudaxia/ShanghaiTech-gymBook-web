/**
 * 调度器：读取 cron.txt，按规则在进程内定时触发刷新
 * 文件里每个非注释行 = 一条规则；只使用前 5 个时间字段，命令字段忽略
 */
import fs from 'node:fs'
import { nextRun, parseCron } from './cron.js'

const DEFAULT_FILE = new URL('../../cron.txt', import.meta.url).pathname

export function loadRules(file = DEFAULT_FILE) {
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
export function startScheduler({ file = DEFAULT_FILE, handler, onLog = console.log } = {}) {
  let rules
  try {
    rules = loadRules(file)
  } catch (err) {
    onLog(`[cron] 规则文件加载失败：${err.message}`)
    return { rules: [], stop() {}, describe: () => [] }
  }

  if (!rules.length) {
    onLog('[cron] cron.txt 里没有有效规则，自动刷新已禁用（仅支持手动刷新）')
    return { rules, stop() {}, describe: () => [] }
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

  // 监听文件变化：直接改 cron.txt 即可生效，无需重启服务
  let reloading = false
  fs.watchFile(file, { interval: 2000 }, () => {
    if (reloading) return
    reloading = true
    setTimeout(() => {
      reloading = false
      for (const r of rules) if (r.timer) clearTimeout(r.timer)
      try {
        const fresh = loadRules(file)
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

  return {
    rules,
    stop() {
      fs.unwatchFile(file)
      for (const r of rules) if (r.timer) clearTimeout(r.timer)
    },
    describe: () =>
      rules.map((r) => ({ expression: r.expression, nextRunAt: r.nextRunAt?.toISOString() ?? null })),
  }
}

function fmt(d) {
  if (!d) return '—'
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}