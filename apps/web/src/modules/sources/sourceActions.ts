import { sourcesApi } from '../../api/client'
import type {OperationOutput} from '@rainver/protocol'

export async function runPendingItemJob(
  itemId: string,
  jobType: string,
  onJobStarted?: () => void,
): Promise<OperationOutput<'source.extraction.dispatch'> | null> {
  const page = await sourcesApi.jobs({
    source_item_id: itemId,
    job_type: jobType,
    status: 'pending',
    limit: 1,
  })
  const job = page.items[0]
  if (!job) return null
  onJobStarted?.()
  return sourcesApi.runJob(job.id)
}
