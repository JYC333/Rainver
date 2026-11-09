/** UI copy: the Sources pages' followed-sources list and source loading states. */
export const sourcesUiZhCN = {
  sources_ui: {
    dispatch: {"queued":'监测扫描已入队',"ended":'监测扫描已结束',"queued_help": "已入队表示请求已接受，不代表处理完成。状态和结果请查看", "results_link": "任务队列", "unknown_help": "任务开始后失败，结果可能未知，且不会自动重试。请先核对任务及来源历史，再发起新操作。", "unknown_result": "结果可能未知：外部效果可能已经发生。此任务不会自动再次执行。请先查看日志和来源结果，再提交新操作。"},
    followed: {
      region: '已关注的来源',
      title: '你关注的来源',
      description: '退订后不再接收新内容，已送达的内容仍可阅读；这些内容也不再影响你的兴趣画像。',
      following: '关注中',
      left: '已退订——此前的内容仍可阅读',
      leave: '退订',
      follow_again: '重新关注',
      left_toast: '已退订该来源。它此前送达的内容仍可在资料库中阅读。',
      rejoined_toast: '已重新关注该来源',
      load_failed: '无法加载你关注的来源。{{message}}',
    },
    detail: {
      load_failed_title: '无法加载此来源',
      retry: '重试',
      refresh_failed: '此来源刷新失败，当前显示的内容可能已过期。{{message}}',
    },
  },
}
