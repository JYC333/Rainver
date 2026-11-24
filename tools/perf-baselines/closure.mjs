import { readFileSync } from 'node:fs'; import { gzipSync } from 'node:zlib'
const [chunksFile, dir] = process.argv.slice(2); const c = JSON.parse(readFileSync(chunksFile, 'utf8'))
const closure = roots => { const seen = new Set(); const q = [...roots]; while (q.length) { const k = q.shift(); if (seen.has(k)) continue; seen.add(k); q.push(...c[k].imports) } return seen }
const find = s => Object.keys(c).find(k => k.includes(s))
const entry = Object.keys(c).find(k => c[k].isEntry && c[k].name === 'app')
// Builds after the boot split also wait for the signed-in app chunk.
const set = closure([entry, find('AuthenticatedApp-'), find('ProjectsModule-'), find('ProjectAreaLayout-')].filter(Boolean))
let raw = 0, gz = 0; for (const k of set) { const b = readFileSync(`${dir}/${k}`); raw += b.length; gz += gzipSync(b).length }
console.log(JSON.stringify({ headingStaticClosure: { n: set.size, raw, gzip: gz } }))
