/**
 * The diary page's own copy. The plugin owns its words; the host only says
 * which locale the person reads (`DiaryWebHost.useLocale`), from the app's one
 * i18n state. An unknown locale reads English.
 */
const en = {
  placeholder: "What's on your mind today?",
  saving: 'Saving…',
  saved: 'Saved',
  save_failed: 'Save failed',
  autosave_hint: 'Auto-saves after typing pauses',
  save_now: 'Save now',
  on_this_day: 'On this day in past years',
  reflections: 'Reflections',
  history: 'History',
  no_entries: 'No entries yet',
  title: 'Diary',
  description: 'Write daily — see what you wrote on this day in past years.',
  enable: 'Install or enable in Optional Modules',
  to_today: '→ today',
  loading: 'Loading…',
}

export type DiaryMessages = typeof en

const zhCN: DiaryMessages = {
  placeholder: '今天在想些什么？',
  saving: '保存中…',
  saved: '已保存',
  save_failed: '保存失败',
  autosave_hint: '停止输入后自动保存',
  save_now: '立即保存',
  on_this_day: '往年的今天',
  reflections: '回顾',
  history: '历史',
  no_entries: '还没有日记',
  title: '日记',
  description: '每天记录，回看往年同一天写下的内容。',
  enable: '在可选模块中安装或启用',
  to_today: '→ 今天',
  loading: '加载中…',
}

export const DIARY_MESSAGES: Record<string, DiaryMessages> = { en, 'zh-CN': zhCN }

export function diaryMessages(locale: string): DiaryMessages {
  return DIARY_MESSAGES[locale] ?? en
}

/**
 * A diary day (`YYYY-MM-DD`, the writer's own calendar day) in the reader's
 * locale. Formatted as that calendar date in UTC so neither the locale nor the
 * browser's time zone can move it to a neighbouring day.
 */
export function formatDiaryDate(iso: string, locale: string, style: 'long' | 'short' = 'long'): string {
  const date = new Date(`${iso}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return iso
  return new Intl.DateTimeFormat(locale, style === 'long'
    ? { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }
    : { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(date)
}
