#!/usr/bin/env bun

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { getMemWiseAgentReadOnlyBashPatterns } from './cli-domains.ts'

interface AllowedBashEntry {
  pattern: string
  comment?: string
}

interface PermissionsConfig {
  version?: string
  allowedBashPatterns?: AllowedBashEntry[]
  [key: string]: unknown
}

function isMemWiseAgentPattern(entry: AllowedBashEntry): boolean {
  return typeof entry.pattern === 'string' && entry.pattern.startsWith('^memwise\\s')
}

function syncMemWiseAgentPatterns(config: PermissionsConfig): PermissionsConfig {
  const patterns = config.allowedBashPatterns ?? []
  const firstMemWiseIndex = patterns.findIndex(isMemWiseAgentPattern)

  const withoutMemWise = patterns.filter(entry => !isMemWiseAgentPattern(entry))
  const generated = getMemWiseAgentReadOnlyBashPatterns()

  const insertAt = firstMemWiseIndex >= 0 ? firstMemWiseIndex : withoutMemWise.length
  const nextAllowedBashPatterns = [
    ...withoutMemWise.slice(0, insertAt),
    ...generated,
    ...withoutMemWise.slice(insertAt),
  ]

  return {
    ...config,
    allowedBashPatterns: nextAllowedBashPatterns,
  }
}

function main() {
  const targetPath = process.argv[2]
    ? resolve(process.argv[2])
    : resolve(process.cwd(), 'apps/electron/resources/permissions/default.json')

  const config = JSON.parse(readFileSync(targetPath, 'utf-8')) as PermissionsConfig
  const nextConfig = syncMemWiseAgentPatterns(config)

  writeFileSync(targetPath, `${JSON.stringify(nextConfig, null, 2)}\n`, 'utf-8')
  process.stdout.write(`Synced memwise bash patterns in ${targetPath}\n`)
}

if (import.meta.main) {
  main()
}
