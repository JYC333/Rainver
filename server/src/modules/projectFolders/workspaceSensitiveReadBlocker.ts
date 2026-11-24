export const workspaceSensitiveReadBlocker = {
  code: 'workspace_sensitive_read_egress',
  message: 'This conversation has sensitive data in its context. Rainver blocked the workspace operation before Git ran.',
} as const;
