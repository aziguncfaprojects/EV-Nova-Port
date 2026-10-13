export type Algorithm = 'SHA-1' | 'SHA-256' | 'SHA-512'

export interface Account {
  id: string
  issuer: string
  label: string
  secret: string
  algorithm: Algorithm
  digits: 6 | 8
  period: number
  createdAt: number
}

export interface TotpResult {
  code: string
  remaining: number
}

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function cleanSecret(value: string) {
  return value.toUpperCase().replace(/[\s-]/g, '')
}

export function isValidSecret(value: string) {
  const cleaned = cleanSecret(value)
  return cleaned.length >= 8 && /^[A-Z2-7]+=*$/.test(cleaned)
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

export function parseOtpUri(raw: string): Omit<Account, 'id' | 'createdAt'> {
  const url = new URL(raw)
  if (url.protocol !== 'otpauth:' || url.hostname !== 'totp') {
    throw new Error('This is not a TOTP authenticator code')
  }

  const pathLabel = decodeURIComponent(url.pathname.replace(/^\//, ''))
  const separator = pathLabel.indexOf(':')
  const pathIssuer = separator >= 0 ? pathLabel.slice(0, separator).trim() : ''
  const label = (separator >= 0 ? pathLabel.slice(separator + 1) : pathLabel).trim()
  const secret = cleanSecret(url.searchParams.get('secret') ?? '')
  const issuer = (url.searchParams.get('issuer') ?? pathIssuer).trim()
  const digitsValue = Number(url.searchParams.get('digits') ?? 6)
  const period = Number(url.searchParams.get('period') ?? 30)
  const algorithmValue = (url.searchParams.get('algorithm') ?? 'SHA1').toUpperCase().replace(
    /^SHA(\d+)$/,
    'SHA-$1',
  ) as Algorithm

  if (!isValidSecret(secret)) throw new Error('The QR code has an invalid secret')
  if (!label) throw new Error('The QR code is missing an account name')
  if (![6, 8].includes(digitsValue)) throw new Error('Only 6 or 8 digit codes are supported')
  if (![15, 30, 60].includes(period)) throw new Error('Unsupported refresh period')
  if (!['SHA-1', 'SHA-256', 'SHA-512'].includes(algorithmValue)) {
    throw new Error('Unsupported security algorithm')
  }

  return {
    issuer: issuer || label.split('@')[1] || 'Account',
    label,
    secret,
    algorithm: algorithmValue,
    digits: digitsValue as 6 | 8,
    period,
  }
}
