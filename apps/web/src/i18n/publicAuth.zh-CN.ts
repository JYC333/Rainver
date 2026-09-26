import type { publicAuthEn } from './publicAuth.en'

type TranslateShape<T> = { [K in keyof T]: T[K] extends string ? string : TranslateShape<T[K]> }

/** Simplified Chinese for public auth pages; keep the English key set complete. */
export const publicAuthZhCN = {
  public_auth: {
    registration: {
      title: '创建首个账户',
      subtitle: '只有已配置的实例管理员可以完成初始注册。',
      open_disabled: '开放注册已关闭。首个账户须使用 INSTANCE_ADMIN_EMAIL；后续账户需要邀请。',
      google_unavailable: 'Google 注册不可用。首个账户仍须使用已配置的管理员邮箱。',
      display_name: '显示名称（可选）',
      email: '邮箱',
      password_bounds: '密码（{{min}}–{{max}} 个字符）',
      creating: '正在创建账户…',
      create_password: '使用密码创建',
      create_google: '使用 Google 创建',
      back_login: '返回登录',
    },
    invitation: {
      token_missing: '邀请链接缺少领取令牌。',
      existing_invalid: '邀请无效、已过期、已使用，或属于其他账户。',
      claim_invalid: '邀请无效、已过期、已撤销，或属于其他邮箱。',
      google_unavailable: 'Google 注册不可用。你可以改用密码注册。',
      register_failed: '无法完成注册。你可以使用此邀请安全地重试。',
      join_space: '加入空间',
      accept_as: '以 {{email}} 的身份接受邀请。',
      joining: '正在加入…',
      join_rainver: '加入 Rainver',
      create_description: '通过此邀请创建账户。',
      invited_email: '受邀邮箱',
      checking: '正在检查…',
      create_new: '创建新账户',
      already_account: '已有账户？请先登录，再重新打开此邀请链接。',
      sign_in: '登录',
      continue_google: '使用 Google 继续',
    },
    reset: {
      title: '重置密码',
      choose_new: '设置 {{min}}–{{max}} 个字符的新密码。',
      new_password: '新密码',
      confirm_password: '确认密码',
      success: '密码已重置，现在可以登录。',
      invalid: '重置链接无效、已过期或已使用。',
      saving: '正在保存…',
    },
  },
} satisfies TranslateShape<typeof publicAuthEn>
