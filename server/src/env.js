/** 统一的 .env 加载（必须作为其它模块的第一个 import，保证在读取 process.env 之前执行） */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.resolve(__dirname, '../..')

for (const candidate of [path.join(ROOT, '.env'), path.join(__dirname, '../.env')]) {
  if (fs.existsSync(candidate)) {
    process.loadEnvFile(candidate)
    break
  }
}