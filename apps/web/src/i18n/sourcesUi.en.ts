/** UI copy: the Sources pages' followed-sources list and source loading states. */
export const sourcesUiEn = {
  sources_ui: {
    dispatch: {"queued":'Monitor scan queued',"ended":'Monitor scan has already ended',"queued_help": "Queued means accepted, not completed. View status and results in", "results_link": "Job Queue", "unknown_help": "If a task fails after starting, its result may be unknown and it will not be retried automatically. Check the task and source history before starting a new action.", "unknown_result": "The result may be unknown: external effects may have occurred. This task will not automatically run again. Inspect its logs and source results before submitting a new action."},
    followed: {
      region: 'Followed sources',
      title: 'Sources you follow',
      description: 'Leaving stops new items and keeps what was already delivered readable. It also stops these items from shaping your interests.',
      following: 'Following',
      left: 'Left — earlier items stay readable',
      leave: 'Leave',
      follow_again: 'Follow again',
      left_toast: 'Left the source. What it already delivered stays readable in your Library.',
      rejoined_toast: 'Following the source again',
      load_failed: 'Sources you follow could not be loaded. {{message}}',
    },
    detail: {
      load_failed_title: 'Could not load this source',
      retry: 'Retry',
      refresh_failed: 'This source could not be refreshed. What is shown may be out of date. {{message}}',
    },
  },
}
