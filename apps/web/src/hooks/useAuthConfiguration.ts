import { useEffect, useState } from 'react'
import { authApi } from '../api/client'
import type { AuthConfiguration } from '../types/api'

export const DEFAULT_AUTH_CONFIGURATION: AuthConfiguration = Object.freeze({
  google_auth_available: false,
  bootstrap_registration_available: false,
  password_min_length: 15,
  password_max_length: 128,
})

export function isPasswordLengthValid(password: string, minimum: number, maximum: number): boolean {
  const length = Array.from(password).length
  return length >= minimum && length <= maximum
}

export function useAuthConfiguration(): AuthConfiguration {
  const [configuration, setConfiguration] = useState(DEFAULT_AUTH_CONFIGURATION)

  useEffect(() => {
    let active = true
    void authApi.configuration()
      .then((result) => {
        if (active) setConfiguration(result)
      })
      .catch(() => {
        // Keep the strict fallback when the public configuration is unavailable.
      })
    return () => {
      active = false
    }
  }, [])

  return configuration
}
