import { existsSync, readFileSync } from 'node:fs'
import { writeFileSync } from 'node:fs'
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/types'
import { settingsFile } from './paths'

function deepMerge<T>(base: T, patch: unknown): T {
  if (patch == null || typeof patch !== 'object' || Array.isArray(patch)) return base
  const out = { ...(base as Record<string, unknown>) }
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    const current = out[key]
    if (current && typeof current === 'object' && !Array.isArray(current) && value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = deepMerge(current, value)
    } else if (value !== undefined) {
      out[key] = value
    }
  }
  return out as T
}

export class SettingsService {
  private value: AppSettings

  constructor() {
    this.value = this.load()
  }

  private load(): AppSettings {
    const file = settingsFile()
    if (!existsSync(file)) return structuredClone(DEFAULT_SETTINGS)
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<AppSettings>
      return deepMerge(structuredClone(DEFAULT_SETTINGS), raw)
    } catch {
      return structuredClone(DEFAULT_SETTINGS)
    }
  }

  get(): AppSettings {
    return this.value
  }

  patch(patch: Partial<AppSettings>): AppSettings {
    this.value = deepMerge(this.value, patch)
    this.save()
    return this.value
  }

  private save(): void {
    try {
      writeFileSync(settingsFile(), JSON.stringify(this.value, null, 2))
    } catch {
      /* settings are best effort */
    }
  }
}
