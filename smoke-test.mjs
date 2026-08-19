// Host-bundle smoke (dev-only): the host half is an intentional no-op that
// keeps the entry a valid cordis plugin row; this just verifies the exports.
import { apply, inject, name } from './lib/index.js'

console.log('name:', name)
console.log('inject:', JSON.stringify(inject))
if (typeof apply !== 'function') throw new Error('apply is not a function')
apply()
console.log('host smoke ok')
