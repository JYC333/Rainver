import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProviderVendorOut } from '../../../api/client'
import i18n from '../../../i18n'
import { ProviderCapabilityNotice } from '../components/ProviderCapability'

const vendors: ProviderVendorOut[] = [{
  id: 'openai', display_name: 'OpenAI', protocol: 'openai', supports_chat: true, supports_structured_output: true,
  supports_embedding: true, supports_rerank: false, default_base_url: null, api_key_required: true,
  subscription_only: false, self_hostable: false,
}]

afterEach(async () => { await i18n.changeLanguage('en') })

describe('ProviderCapabilityNotice', () => {
  it('joins each capability with its detail in English', () => {
    render(<ProviderCapabilityNotice providerType="openai" vendors={vendors} />)
    expect(screen.getByText(
      'Chat: Can be used for normal assistant/model calls and query rewrite. Embeddings: Can be used by retrieval vector search.',
    )).toBeInTheDocument()
  })

  it('joins each capability with its detail in Chinese', async () => {
    await i18n.changeLanguage('zh-CN')
    render(<ProviderCapabilityNotice providerType="openai" vendors={vendors} />)
    expect(screen.getByText('对话：可用于普通助手和模型调用，以及查询改写。嵌入：可用于检索的向量搜索。')).toBeInTheDocument()
  })
})
