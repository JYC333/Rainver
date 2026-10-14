import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import i18n from '../../i18n'
import TimePage from './TimePage'

afterEach(async () => { await i18n.changeLanguage('en') })

describe('TimePage', () => {
  it('says the module is planned, in the UI language', async () => {
    const english = render(<TimePage />)
    expect(screen.getByText('Planned')).toBeInTheDocument()
    expect(screen.getByText(/Nothing here records or stores time/)).toBeInTheDocument()
    english.unmount()

    await i18n.changeLanguage('zh-CN')
    render(<TimePage />)
    expect(screen.getByText('计划中')).toBeInTheDocument()
    expect(screen.getByText(/这里不会记录或保存任何时间/)).toBeInTheDocument()
  })
})
