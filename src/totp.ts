export type Algorithm = 'SHA-1' | 'SHA-256' | 'SHA-512'
export type AccountKind = 'microsoft-personal' | 'microsoft-work' | 'other'

export interface Account {
  id: string
  issuer: string
  label: string
  secret: string
  algorithm: Algorithm
  digits: 6 | 8
  period: number
  kind?: AccountKind
  createdAt: number
}

export interface TotpResult {
  code: string
  remaining: number
}

export type ParsedAccount = Omit<Account, 'id' | 'createdAt'>

export type SetupCode =
  | { type: 'totp'; account: ParsedAccount }
  | { type: 'secret'; secret: string }
  | { type: 'microsoft-push' }

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function cleanSecret(value: string) {
  return value.toUpperCase().replace(/[\s-]/g, '')
}

export function isValidSecret(value: string) {
  const cleaned = cleanSecret(value)
  return cleaned.length >= 8 && /^[A-Z2-7]+=*$/.test(cleaned)
}

export function inferKind(issuer: string, label: string): AccountKind {
  const haystack = `${issuer} ${label}`.toLowerCase()
  if (/(azure|entra|office.?365|work or school|onmicrosoft\.com)/.test(haystack)) return 'microsoft-work'
  if (/(microsoft|outlook|hotmail|live\.com|\bmsn\b)/.test(haystack)) return 'microsoft-personal'
  return 'other'
}

export function resolveKind(account: Pick<Account, 'issuer' | 'label' | 'kind'>): AccountKind {
  return account.kind ?? inferKind(account.issuer, account.label)
}

export function formatCode(code: string) {
  if (!/^\d+$/.test(code)) return code
  const midpoint = Math.ceil(code.length / 2)
  return `${code.slice(0, midpoint)} ${code.slice(midpoint)}`
}

function decodeBase32(value: string) {
  const input = cleanSecret(value).replace(/=+$/, '')
  let bits = ''
  for (const char of input) {
    const index = alphabet.indexOf(char)
    if (index < 0) throw new Error('Invalid Base32 secret')
    bits += index.toString(2).padStart(5, '0')
  }
  const bytes = new Uint8Array(Math.floor(bits.length / 8))
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2)
  }
  if (!bytes.length) throw new Error('Invalid Base32 secret')
  return bytes
}

function counterBytes(counter: number) {
  const bytes = new Uint8Array(8)
  let value = counter
  for (let i = 7; i >= 0; i -= 1) {
    bytes[i] = value & 0xff
    value = Math.floor(value / 256)
  }
  return bytes
}

export async function generateTotp(account: Account, now = Date.now()): Promise<TotpResult> {
  const counter = Math.floor(now / 1000 / account.period)
  const key = await crypto.subtle.importKey(
    'raw',
    decodeBase32(account.secret),
    { name: 'HMAC', hash: account.algorithm },
    false,
    ['sign'],
  )
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, counterBytes(counter)))
  const offset = digest[digest.length - 1] & 0x0f
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff)
  const code = String(binary % 10 ** account.digits).padStart(account.digits, '0')
  const elapsed = Math.floor(now / 1000) % account.period
  return { code, remaining: account.period - elapsed }
}

function decodePath(pathname: string) {
  const value = pathname.replace(/^\//, '')
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function isPersonalMicrosoftLabel(label: string) {
  return /@(outlook|hotmail|live|msn)\./i.test(label)
}

function isMicrosoftActivation(value: string) {
  if (/^(phonefactor|phoneappnotification|msauth|ms-msa):/i.test(value)) return true
  try {
    const url = new URL(value)
    const host = url.hostname.toLowerCase()
    return host === 'mobileappcommunicator.auth.microsoft.com' || (host === 'aka.ms' && /mfa|auth/i.test(url.pathname))
  } catch {
    return false
  }
}

export function parseOtpUri(raw: string): ParsedAccount {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new Error('This QR code is not an authenticator setup code')
  }
  if (url.protocol !== 'otpauth:' || url.hostname !== 'totp') {
    throw new Error(url.hostname === 'hotp' ? 'This is a counter-based code. Microsoft sign-in uses a time-based code.' : 'This QR code is not a time-based authenticator code')
  }

  const pathLabel = decodePath(url.pathname).trim()
  const separator = pathLabel.indexOf(':')
  const pathIssuer = separator >= 0 ? pathLabel.slice(0, separator).trim() : ''
  const label = (separator >= 0 ? pathLabel.slice(separator + 1) : pathLabel).trim()
  const secret = cleanSecret(url.searchParams.get('secret') ?? '')
  const queryIssuer = (url.searchParams.get('issuer') ?? '').trim()
  const digitsValue = Number(url.searchParams.get('digits') ?? 6)
  const period = Number(url.searchParams.get('period') ?? 30)
  const algorithmValue = (url.searchParams.get('algorithm') ?? 'SHA1').toUpperCase().replace(/^SHA(\d+)$/, 'SHA-$1') as Algorithm
  const microsoftIssued = /^microsoft$/i.test(queryIssuer) || /^microsoft$/i.test(pathIssuer)
  const kind: AccountKind = microsoftIssued
    ? (isPersonalMicrosoftLabel(label) ? 'microsoft-personal' : 'microsoft-work')
    : inferKind(queryIssuer || pathIssuer, label)

  if (!isValidSecret(secret)) throw new Error('The QR code has an invalid secret')
  if (!label) throw new Error('The QR code is missing an account name')
  if (kind === 'other' && ![6, 8].includes(digitsValue)) throw new Error('Only 6 or 8 digit codes are supported')
  if (kind === 'other' && ![15, 30, 60].includes(period)) throw new Error('Unsupported refresh period')
  if (kind === 'other' && !['SHA-1', 'SHA-256', 'SHA-512'].includes(algorithmValue)) throw new Error('Unsupported security algorithm')

  const issuer = pathIssuer && !/^microsoft$/i.test(pathIssuer)
    ? pathIssuer
    : kind === 'microsoft-personal'
      ? 'Microsoft account'
      : kind === 'microsoft-work'
        ? (label.split('@')[1] || 'Work or school')
        : (queryIssuer || pathIssuer || label.split('@')[1] || 'Account')

  return {
    issuer,
    label,
    secret,
    kind,
    algorithm: kind === 'other' ? algorithmValue : 'SHA-1',
    digits: kind === 'other' ? digitsValue as 6 | 8 : 6,
    period: kind === 'other' ? period : 30,
  }
}

export function inspectSetupCode(raw: string, preferredKind: AccountKind = 'other'): SetupCode {
  const value = raw.trim()
  if (/^otpauth-migration:/i.test(value)) {
    throw new Error('This is an account export, not a Microsoft setup code. Scan the QR code shown while adding the sign-in method.')
  }
  const embedded = value.match(/otpauth:\/\/\S+/i)?.[0]
  const candidate = embedded ?? value
  if (!embedded && isMicrosoftActivation(candidate)) return { type: 'microsoft-push' }
  if (!candidate.includes('://') && isValidSecret(candidate)) return { type: 'secret', secret: cleanSecret(candidate) }

  const account = parseOtpUri(candidate)
  if (preferredKind !== 'other' && account.kind !== 'other') {
    account.kind = preferredKind
    if (preferredKind === 'microsoft-personal' && /^microsoft$/i.test(account.issuer)) account.issuer = 'Microsoft account'
  }
  return { type: 'totp', account }
}
