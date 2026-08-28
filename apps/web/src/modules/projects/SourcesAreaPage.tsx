import { useSearchParams } from 'react-router-dom'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs'
import ProjectSourcesPage from './ProjectSourcesPage'
import ProjectRawMaterialPage from './ProjectRawMaterialPage'
import ProjectDigestPage from './ProjectDigestPage'

/**
 * One Area for the source → corpus pipeline.
 *
 * Sources (what is bound and how it is read), Raw material (what arrived and
 * has not been looked at), and Digest (what was extracted) were three sidebar
 * entries reading one pipeline at three points. Three doors to one room made
 * the list longer without making anything easier to find; the tab carries the
 * same three points of view.
 */
const TABS = ['sources', 'raw', 'digest'] as const
type Tab = typeof TABS[number]

export default function SourcesAreaPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const requested = searchParams.get('tab') as Tab | null
  const tab: Tab = requested && TABS.includes(requested) ? requested : 'sources'

  return (
    <Tabs
      value={tab}
      onValueChange={value => {
        const next = new URLSearchParams(searchParams)
        if (value === 'sources') next.delete('tab')
        else next.set('tab', value)
        setSearchParams(next, { replace: true })
      }}
    >
      {/* The tab bar only; each tab keeps its own page padding and heading. */}
      <div className="px-6 pt-4 -mb-2">
        <TabsList className="grid w-full max-w-md grid-cols-3">
          <TabsTrigger value="sources">Sources</TabsTrigger>
          <TabsTrigger value="raw">Raw material</TabsTrigger>
          <TabsTrigger value="digest">Digest</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="sources"><ProjectSourcesPage /></TabsContent>
      <TabsContent value="raw"><ProjectRawMaterialPage /></TabsContent>
      <TabsContent value="digest"><ProjectDigestPage /></TabsContent>
    </Tabs>
  )
}
