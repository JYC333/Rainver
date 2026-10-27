import type { digestReportsEn } from './digestReports.en'

type Shape<T> = { [K in keyof T]: T[K] extends string ? string : Shape<T[K]> }

/** 摘要日期、补生成与标注恢复的中文文案。 */
export const digestReportsZhCN = {
  day_label: '{{date}} · {{timezone}}',
  scheduled: '计划生成的摘要',
  backfilled: '补生成于 {{when}}',
  backfill_note: '依据当前保留的材料补生成，不含"常规视野之外"部分。',
  missing_reason: {
    monitoring_history_before_latest: '已有更新的监测日报封存，缺失日期只能向前补生成。',
    not_generated: '这一天没有生成摘要。可以用现在保留的材料补生成。',
    day_not_complete: '按摘要的时区，这一天还没有结束；摘要会在这一天结束后生成。',
  },
  missing_title: '{{date}} 没有摘要',
  backfill: '补生成这一天',
  backfilling: '正在补生成…',
  backfill_done: '已补生成摘要',
  backfill_existing: '这一天已有摘要',
  previous_day: '前一天',
  next_day: '后一天',
  annotation_retry_scheduled_one: '你的 {{count}} 条内容标注失败。下次自动重试{{relative}}（{{when}}）。',
  annotation_retry_scheduled_other: '你的 {{count}} 条内容标注失败。下次自动重试{{relative}}（{{when}}）。',
  annotation_budget_exhausted_one: '你的 {{count}} 条内容多次标注失败，已暂停。',
  annotation_budget_exhausted_other: '你的 {{count}} 条内容多次标注失败，已暂停。',
  annotation_provider_unavailable_one: '你的 {{count}} 条内容正在等待本空间配置标注所用的模型提供方。',
  annotation_provider_unavailable_other: '你的 {{count}} 条内容正在等待本空间配置标注所用的模型提供方。',
  annotation_egress_denied_one: '你的 {{count}} 条内容正在等待其来源允许发送给标注模型。',
  annotation_egress_denied_other: '你的 {{count}} 条内容正在等待其来源允许发送给标注模型。',
  annotation_consent_missing_one: '你的 {{count}} 条内容正在等待其来源授予同意。',
  annotation_consent_missing_other: '你的 {{count}} 条内容正在等待其来源授予同意。',
  annotation_retry: '立即重试',
  annotation_retrying: '正在重试…',
  annotation_retry_done_one: '已将 {{count}} 条内容加入标注队列',
  annotation_retry_done_other: '已将 {{count}} 条内容加入标注队列',
  annotation_retry_nothing: '暂时没有可重试的内容，等待条件仍未满足。',
  daily_run_title: '生成最近一个完整日的报告',
  daily_run_hint: '报告覆盖 {{timezone}} 时区中的一整天；尚未结束的一天不能生成报告。',
} satisfies Shape<typeof digestReportsEn>
