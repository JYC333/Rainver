import type { Extension } from '@codemirror/state'
import { StreamLanguage } from '@codemirror/language'

export type CodeMirrorLanguage =
  | 'javascript'
  | 'json'
  | 'markdown'
  | 'yaml'
  | 'python'
  | 'sql'
  | 'html'
  | 'css'
  | 'rust'
  | 'shell'
  | 'plain'

const EXTENSIONS: Record<string, CodeMirrorLanguage> = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'javascript', tsx: 'javascript', mts: 'javascript', cts: 'javascript',
  json: 'json', jsonc: 'json',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  yaml: 'yaml', yml: 'yaml',
  py: 'python', pyw: 'python',
  sql: 'sql',
  html: 'html', htm: 'html',
  css: 'css',
  rs: 'rust',
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell',
}
export function languageForPath(path: string): CodeMirrorLanguage {
  const name = path.split('/').pop()?.toLowerCase() ?? ''
  if (name === 'dockerfile' || name === 'makefile') return 'shell'
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : ''
  return EXTENSIONS[extension] ?? 'plain'
}

export async function loadLanguage(language: CodeMirrorLanguage): Promise<Extension> {
  switch (language) {
    case 'javascript': {
      const module = await import('@codemirror/lang-javascript')
      return module.javascript({ jsx: true, typescript: true })
    }
    case 'json': {
      const module = await import('@codemirror/lang-json')
      return module.json()
    }
    case 'markdown': {
      const module = await import('@codemirror/lang-markdown')
      return module.markdown()
    }
    case 'yaml': {
      const module = await import('@codemirror/lang-yaml')
      return module.yaml()
    }
    case 'python': {
      const module = await import('@codemirror/lang-python')
      return module.python()
    }
    case 'sql': {
      const module = await import('@codemirror/lang-sql')
      return module.sql()
    }
    case 'html': {
      const module = await import('@codemirror/lang-html')
      return module.html()
    }
    case 'css': {
      const module = await import('@codemirror/lang-css')
      return module.css()
    }
    case 'rust': {
      const module = await import('@codemirror/lang-rust')
      return module.rust()
    }
    case 'shell': {
      const module = await import('@codemirror/legacy-modes/mode/shell')
      return StreamLanguage.define(module.shell)
    }
    case 'plain':
    default:
      return []
  }
}
