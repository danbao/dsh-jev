/**
 * Packaging contract.
 *
 * `dsh plugin add` reads `dsh.bundle.patch` from package.json and applies that
 * YAML to the profile, so a malformed patch or a patch pointing at a missing
 * file fails the install — the failure mode this test exists to catch, and the
 * one that is invisible to unit tests of the plugin's own code.
 */

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const root = fileURLToPath(new URL('..', import.meta.url))

/** Read and parse the package manifest. */
function manifest(): Record<string, unknown> {
  return JSON.parse(readFileSync(`${root}package.json`, 'utf8')) as Record<string, unknown>
}

describe('package manifest', () => {
  it('declares the bundle patch that dsh reads', () => {
    const dsh = manifest().dsh as { bundle?: { patch?: string } } | undefined
    expect(dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(existsSync(`${root}cordis.patch.yml`)).toBe(true)
  })

  it('points the package entry at the built entry and its declarations', () => {
    const pkg = manifest()
    expect(pkg.main).toBe('./dist/index.js')
    expect(existsSync(`${root}dist/index.js`)).toBe(true)
    const exports = pkg.exports as Record<string, { import?: string; types?: string }>
    expect(exports['.']?.import).toBe('./dist/index.js')
    expect(exports['.']?.types).toBe('./dist/index.d.ts')
    expect(existsSync(`${root}dist/index.d.ts`)).toBe(true)
    expect(exports['./package.json']).toBe('./package.json')
  })

  it('ships the patch, the built output, and the docs', () => {
    const files = manifest().files as string[]
    expect(files).toContain('dist')
    expect(files).toContain('cordis.patch.yml')
    expect(files).toContain('README.md')
    expect(files).toContain('LICENSE')
  })

  it('keeps the harness packages as peers rather than bundling them', () => {
    const pkg = manifest()
    const peers = Object.keys(pkg.peerDependencies as Record<string, string>)
    expect(peers).toContain('@deepseek-ai/dsh-tools')
    expect(peers).toContain('@deepseek-ai/dsh-settings')
    expect(peers).toContain('@deepseek-ai/dsh-credentials')
    // A bundled harness copy would give the profile a second Cordis runtime.
    expect(pkg.dependencies).toBeUndefined()
  })
})

describe('cordis.patch.yml', () => {
  it('inserts exactly the jev row the bundle is named for', () => {
    const patch = parse(readFileSync(`${root}cordis.patch.yml`, 'utf8')) as Array<{
      insert: Array<{ id: string; name: string }>
    }>
    expect(Array.isArray(patch)).toBe(true)
    expect(patch).toHaveLength(1)
    expect(patch[0]?.insert).toHaveLength(1)
    expect(patch[0]?.insert[0]).toMatchObject({ id: 'jev', name: 'dsh-jev' })
  })

  it('needs no configuration to be valid, because every field has a default', () => {
    const patch = parse(readFileSync(`${root}cordis.patch.yml`, 'utf8')) as Array<{
      insert: Array<{ config?: unknown }>
    }>
    expect(patch[0]?.insert[0]).not.toHaveProperty('config')
  })
})

describe('bundled documentation', () => {
  it('documents the state_json override and the two backends', () => {
    const readme = readFileSync(`${root}README.md`, 'utf8')
    expect(readme).toMatch(/state_json/)
    expect(readme).toMatch(/openrouter/)
    expect(readme).toMatch(/typesafe/)
  })
})
