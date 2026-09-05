import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { hostsApi } from '../../api/client'
import { errMsg } from '../../lib/utils'
import type { HostRuntimeProviderBinding } from '../../types/api'
import { AMBIENT_BACKEND } from './backendChoice'

/** Owns the host × adapter ModelProvider bindings used by the Agent rows. */
export function useHostProviderBindings(hostId: string, enabled: boolean) {
  const [bindings, setBindings] = useState<HostRuntimeProviderBinding[]>([])
  const [busyAdapter, setBusyAdapter] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!enabled) {
      setBindings([])
      setLoading(false)
      return
    }
    let cancelled = false
    setBindings([])
    setLoading(true)
    hostsApi.listProviderBindings(hostId)
      .then(result => { if (!cancelled) setBindings(result.items) })
      .catch(error => { if (!cancelled) toast.error(errMsg(error)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [hostId, enabled])

  const choose = useCallback(async (adapterType: string, providerId: string) => {
    const current = bindings.find(binding => binding.adapter_type === adapterType)?.model_provider_id ?? AMBIENT_BACKEND
    if (providerId === current) return
    setBusyAdapter(adapterType)
    try {
      if (providerId === AMBIENT_BACKEND) {
        await hostsApi.clearProviderBinding(hostId, adapterType)
        setBindings(currentBindings => currentBindings.filter(binding => binding.adapter_type !== adapterType))
      } else {
        const saved = await hostsApi.setProviderBinding(hostId, adapterType, providerId)
        setBindings(currentBindings => [
          ...currentBindings.filter(binding => binding.adapter_type !== adapterType),
          saved,
        ])
      }
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setBusyAdapter(null)
    }
  }, [bindings, hostId])

  return { bindings, busyAdapter, loading, choose }
}
