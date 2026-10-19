/** UI copy for the conversation knowledge-retrieval switch. */
export const conversationRetrievalEn = {
  conversation_retrieval: {
    group: 'Knowledge retrieval',
    on: 'Knowledge: on',
    off: 'Knowledge: off',
    hint: 'Search the knowledge base for each turn of this conversation. Attached material is used either way.',
    unavailable_until_started: 'Available once the conversation has started.',
    failed: 'The knowledge retrieval setting could not be saved.',
    load_failed: 'The knowledge retrieval setting could not be loaded.',
    retry: 'Retry',
    room_hint: 'Search the knowledge base for {{agent}}\'s turns in this Room. Attached material is used either way.',
    agent_on: '{{agent}} · Knowledge: on',
    agent_off: '{{agent}} · Knowledge: off',
    domains: 'Search in',
    domain: {
      knowledge: 'Knowledge',
      sources: 'Sources',
      memory: 'Memory',
      projects: 'Project summaries',
      inquiry: 'Inquiry threads',
    },
  },
}
