import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import { Pagination } from '../ui/pagination'
import { DatePicker } from '../ui/date-picker'
import { ConfirmDialog } from '../ui/dialog'
import { OneTimeLink } from '../OneTimeLink'
import { NoteRevisionHistory } from '../editor/NoteRevisionHistory'
import { GraphView } from '../graph'
import ErrorBoundary from '../../core/ErrorBoundary'

vi.mock('../../core/spaceNav', () => ({
  SpaceLink: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
}))

afterEach(async () => { await i18n.changeLanguage('en') })

describe('shared components in Chinese', () => {
  it('words pagination, the date picker and the confirm dialog in the UI locale', async () => {
    await i18n.changeLanguage('zh-CN')
    render(<Pagination total={1200} limit={50} offset={50} onChange={() => undefined} />)
    expect(screen.getByText('第 51–100 条，共 1,200 条')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '上一页' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '下一页' })).toBeInTheDocument()

    render(<DatePicker value="2026-10-14" onChange={() => undefined} ariaLabel="日期" />)
    expect(screen.getByText('2026年10月14日')).toBeInTheDocument()

    render(<ConfirmDialog open onOpenChange={() => undefined} title="删除？" onConfirm={() => undefined} />)
    expect(screen.getByRole('button', { name: '确认' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '取消' })).toBeInTheDocument()
  })

  it('words the one-time link, revision history, graph states and error boundary', async () => {
    await i18n.changeLanguage('zh-CN')
    render(<OneTimeLink secret link="https://example.test/x" label="重置链接" onDismiss={() => undefined} />)
    expect(screen.getByRole('button', { name: '复制' })).toBeInTheDocument()
    expect(screen.getByText(/当作机密处理/)).toBeInTheDocument()

    render(<MemoryRouter><NoteRevisionHistory revisions={[]} currentVersion={1} onRollback={() => undefined} /></MemoryRouter>)
    expect(screen.getByText('版本历史')).toBeInTheDocument()
    expect(screen.getByText('还没有历史记录。')).toBeInTheDocument()

    render(<GraphView projection={null} loading />)
    expect(screen.getByText('正在加载图…')).toBeInTheDocument()

    const Boom = () => { throw new Error('boom') }
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(<ErrorBoundary><Boom /></ErrorBoundary>)
    expect(screen.getByText('此页面出错了')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
  })
})
