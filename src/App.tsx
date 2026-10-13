import { useEffect, useMemo, useRef, useState } from 'react'
import { BrowserQRCodeReader, type IScannerControls } from '@zxing/browser'
import {
  type Account,
  type AccountKind,
  cleanSecret,
  formatCode,
  generateTotp,
  inspectSetupCode,
  isValidSecret,
  resolveKind,
} from './totp'

const STORAGE_KEY = 'keyra-accounts-v1'
const PUSH_HELP = 'This QR code registers push approval in Microsoft Authenticator. On the Microsoft page, go back and choose “Set up a different Authenticator app” or “I want to use a different authenticator app”, then scan the verification-code QR.'

type IconName = 'plus' | 'scan' | 'key' | 'copy' | 'check' | 'trash' | 'x' | 'shield' | 'briefcase' | 'user' | 'grid'
type SheetMode = 'choice' | 'guide' | 'manual' | 'scan'
type Notice = { tone: 'error' | 'info'; text: string } | null

const guides: Record<Exclude<AccountKind, 'other'>, { title: string; steps: string[] }> = {
  'microsoft-personal': {
    title: 'Personal account',
    steps: [
      'On a computer, open account.microsoft.com/security.',
      'Choose Manage how I sign in, then Add a new way to sign in or verify, then Use an app.',
      'Choose Set up a different Authenticator app and select Next.',
      'Scan the QR code, or enter the secret key shown if you cannot scan.',
      'Enter the 6-digit code from Keyra on the Microsoft page.',
    ],
  },
  'microsoft-work': {
    title: 'Work or school account',
    steps: [
      'On a computer, open mysignins.microsoft.com/security-info.',
      'Choose Add sign-in method, then Microsoft Authenticator.',
      'Choose I want to use a different authenticator app.',
      'Scan the QR code, or enter the account name and secret key.',
      'Enter the 6-digit code from Keyra on the Microsoft page.',
    ],
  },
}

const iconPaths: Record<IconName, React.ReactNode> = {
  plus: <><path d="M12 5v14M5 12h14" /></>,
  scan: <><path d="M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3" /><path d="M7 12h10" /></>,
  key: <><circle cx="8.5" cy="15.5" r="4.5" /><path d="m12 12 8-8M17 7l3 3M14 10l3 3" /></>,
  copy: <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3" /></>,
  check: <><path d="m5 12 4 4L19 6" /></>,
  trash: <><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5" /></>,
  x: <><path d="m6 6 12 12M18 6 6 18" /></>,
  shield: <><path d="M12 3 5 6v5c0 4.6 2.8 8 7 10 4.2-2 7-5.4 7-10V6l-7-3Z" /><path d="m9 12 2 2 4-4" /></>,
  briefcase: <><rect x="3" y="7" width="18" height="13" rx="2" /><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12h18" /></>,
  user: <><circle cx="12" cy="8" r="3.2" /><path d="M5 19a7 7 0 0 1 14 0" /></>,
  grid: <><rect x="4" y="4" width="6.5" height="6.5" rx="1" /><rect x="13.5" y="4" width="6.5" height="6.5" rx="1" /><rect x="4" y="13.5" width="6.5" height="6.5" rx="1" /><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1" /></>,
}

function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{iconPaths[name]}</svg>
}

function MicrosoftMark() {
  return (
    <svg className="ms-mark" viewBox="0 0 24 24" aria-hidden>
      <rect x="1" y="1" width="10" height="10" fill="#f25022" />
      <rect x="13" y="1" width="10" height="10" fill="#7fba00" />
      <rect x="1" y="13" width="10" height="10" fill="#00a4ef" />
      <rect x="13" y="13" width="10" height="10" fill="#ffb900" />
    </svg>
  )
}

function loadAccounts(): Account[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function initials(issuer: string) {
  return issuer.split(/\s+/).map((word) => word[0]).join('').slice(0, 2).toUpperCase()
}

function colorFor(value: string) {
  const colors = ['#315b4a', '#a34f32', '#526296', '#806230', '#6e4d75', '#296c72']
  return colors[[...value].reduce((sum, char) => sum + char.charCodeAt(0), 0) % colors.length]
}

function Countdown({ remaining, period }: { remaining: number; period: number }) {
  const radius = 15
  const circumference = 2 * Math.PI * radius
  const urgent = remaining <= 5
  return (
    <div className={`ring-wrap ${urgent ? 'urgent' : ''}`} aria-label={`${remaining} seconds remaining`}>
      <svg viewBox="0 0 40 40" className="ring">
        <circle cx="20" cy="20" r={radius} />
        <circle cx="20" cy="20" r={radius} strokeDasharray={circumference} strokeDashoffset={circumference * (1 - remaining / period)} />
      </svg>
      <span>{remaining}</span>
    </div>
  )
}

function CodeCard({ account, tick, onDelete }: { account: Account; tick: number; onDelete: () => void }) {
  const [result, setResult] = useState({ code: '••••••', remaining: account.period })
  const [copied, setCopied] = useState(false)
  const microsoft = resolveKind(account) !== 'other'

  useEffect(() => {
    generateTotp(account).then(setResult).catch(() => setResult({ code: 'Invalid', remaining: 0 }))
  }, [account, tick])

  const copy = async () => {
    if (!/^\d+$/.test(result.code)) return
    await navigator.clipboard.writeText(result.code)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1400)
  }

  return (
    <article className="code-card">
      <div className="account-row">
        {microsoft ? <div className="account-mark microsoft"><MicrosoftMark /></div> : <div className="account-mark" style={{ background: colorFor(account.issuer) }}>{initials(account.issuer)}</div>}
        <div className="account-meta">
          <strong>{account.issuer}</strong>
          <span>{account.label}</span>
          {microsoft && <em className="ms-badge">Microsoft sign-in</em>}
        </div>
        <button className="icon-button delete" onClick={onDelete} aria-label={`Delete ${account.issuer}`}><Icon name="trash" size={18} /></button>
      </div>
      <div className="code-row">
        <button className="code" onClick={copy} aria-label="Copy verification code">{formatCode(result.code)}</button>
        <Countdown remaining={result.remaining} period={account.period} />
        <button className={`copy-button ${copied ? 'copied' : ''}`} onClick={copy}>
          <Icon name={copied ? 'check' : 'copy'} size={19} />{copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {microsoft && <p className="signin-hint">At the Microsoft prompt, choose Use a verification code and enter this code.</p>}
    </article>
  )
}

function AddSheet({ onClose, onAdd }: { onClose: () => void; onAdd: (account: Account) => string | void }) {
  const [mode, setMode] = useState<SheetMode>('choice')
  const [kind, setKind] = useState<AccountKind>('other')
  const [issuer, setIssuer] = useState('')
  const [label, setLabel] = useState('')
  const [secret, setSecret] = useState('')
  const [notice, setNotice] = useState<Notice>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const controls = useRef<IScannerControls | null>(null)
  const kindRef = useRef(kind)
  kindRef.current = kind

  const acceptSetup = (value: string) => {
    try {
      const setup = inspectSetupCode(value, kindRef.current)
      if (setup.type === 'microsoft-push') {
        setNotice({ tone: 'info', text: PUSH_HELP })
        return
      }
      if (setup.type === 'secret') {
        setSecret(setup.secret)
        setMode('manual')
        setNotice({ tone: 'info', text: 'Secret key found. Add the account name to finish.' })
        return
      }
      const error = onAdd({ ...setup.account, id: crypto.randomUUID(), createdAt: Date.now() })
      if (error) setNotice({ tone: 'error', text: error })
    } catch (err) {
      setNotice({ tone: 'error', text: err instanceof Error ? err.message : 'Unable to read that code' })
    }
  }

  useEffect(() => {
    if (mode !== 'scan' || !videoRef.current) return
    let active = true
    const reader = new BrowserQRCodeReader()
    reader.decodeFromVideoDevice(undefined, videoRef.current, (result) => {
      if (result && active) {
        active = false
        controls.current?.stop()
        acceptSetup(result.getText())
      }
    }).then((value) => { controls.current = value }).catch(() => {
      setNotice({ tone: 'error', text: 'Camera access was unavailable. You can choose a QR image or enter the secret key.' })
    })
    return () => { active = false; controls.current?.stop() }
  }, [mode])

  const openGuide = (nextKind: Exclude<AccountKind, 'other'>) => {
    setKind(nextKind)
    setIssuer(nextKind === 'microsoft-work' ? '' : 'Microsoft account')
    setLabel('')
    setSecret('')
    setNotice(null)
    setMode('guide')
  }

  const saveManual = () => {
    const accountLabel = label.trim()
    const accountIssuer = kind === 'microsoft-personal'
      ? 'Microsoft account'
      : kind === 'microsoft-work'
        ? (issuer.trim() || accountLabel.split('@')[1] || 'Work or school')
        : issuer.trim()
    if (!accountIssuer || !accountLabel) {
      setNotice({ tone: 'error', text: kind === 'other' ? 'Add a service and account name' : 'Add the Microsoft account name' })
      return
    }
    if (!isValidSecret(secret)) {
      setNotice({ tone: 'error', text: 'Enter a valid Base32 secret key' })
      return
    }
    const error = onAdd({
      id: crypto.randomUUID(),
      issuer: accountIssuer,
      label: accountLabel,
      secret: cleanSecret(secret),
      algorithm: 'SHA-1',
      digits: 6,
      period: 30,
      kind,
      createdAt: Date.now(),
    })
    if (error) setNotice({ tone: 'error', text: error })
  }

  const scanFile = async (file?: File) => {
    if (!file) return
    try {
      controls.current?.stop()
      const url = URL.createObjectURL(file)
      const result = await new BrowserQRCodeReader().decodeFromImageUrl(url)
      URL.revokeObjectURL(url)
      acceptSetup(result.getText())
    } catch {
      setNotice({ tone: 'error', text: 'No authenticator QR code was found in that image' })
    }
  }

  const back = () => {
    controls.current?.stop()
    setNotice(null)
    setMode(kind === 'other' || mode === 'guide' ? 'choice' : 'guide')
  }
  const title = mode === 'choice' ? 'Add account' : mode === 'guide' ? guides[kind as Exclude<AccountKind, 'other'>].title : mode === 'scan' ? 'Scan QR code' : 'Enter secret key'

  return (
    <div className="sheet-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
        <div className="sheet-handle" />
        <header className="sheet-header">
          <div>
            <span className="eyebrow">New account</span>
            <h2 id="sheet-title">{title}</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </header>

        {mode === 'choice' && <div className="add-options">
          <button onClick={() => openGuide('microsoft-work')}><span className="option-icon sand"><Icon name="briefcase" size={22} /></span><span><strong>Work or school account</strong><small>Microsoft 365, Entra, and Azure sign-in</small></span><b>→</b></button>
          <button onClick={() => openGuide('microsoft-personal')}><span className="option-icon lime"><Icon name="user" size={22} /></span><span><strong>Personal account</strong><small>Outlook, Hotmail, and Microsoft account</small></span><b>→</b></button>
          <button onClick={() => { setKind('other'); setIssuer(''); setLabel(''); setSecret(''); setNotice(null); setMode('scan') }}><span className="option-icon sand"><Icon name="grid" size={22} /></span><span><strong>Other account</strong><small>Google, Facebook, and other verification codes</small></span><b>→</b></button>
          <div className="privacy-note"><Icon name="shield" size={18} /><span>Microsoft sign-in uses the 6-digit code stored only on this device.</span></div>
        </div>}

        {mode === 'guide' && kind !== 'other' && <div className="guide">
          <p>Keyra creates the same 6-digit verification code Microsoft accepts at sign-in.</p>
          <ol className="steps">{guides[kind].steps.map((step, index) => <li key={step}><b>{index + 1}</b><span>{step}</span></li>)}</ol>
          <div className="guide-actions">
            <button className="primary full" onClick={() => { setNotice(null); setMode('scan') }}><Icon name="scan" size={18} />Scan QR code</button>
            <button className="secondary" onClick={() => { setNotice(null); setMode('manual') }}><Icon name="key" size={18} />Enter secret key</button>
          </div>
          <button className="text-button" onClick={back}>Back</button>
        </div>}

        {mode === 'manual' && <div className="form">
          {kind === 'microsoft-work' && <label>Organization<input autoFocus value={issuer} onChange={(e) => setIssuer(e.target.value)} placeholder="contoso.com" autoComplete="off" /></label>}
          {kind === 'other' && <label>Service<input autoFocus value={issuer} onChange={(e) => setIssuer(e.target.value)} placeholder="e.g. GitHub" autoComplete="off" /></label>}
          <label>{kind === 'other' ? 'Account' : 'Account name'}<input autoFocus={kind === 'microsoft-personal'} value={label} onChange={(e) => setLabel(e.target.value)} placeholder={kind === 'other' ? 'name@example.com' : 'name@contoso.com'} autoComplete="off" /></label>
          <label>Secret key<input className="secret-input" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="JBSW Y3DP EHPK 3PXP" autoCapitalize="characters" autoComplete="off" /></label>
          {notice && <p className={notice.tone === 'info' ? 'notice info' : 'error'}>{notice.text}</p>}
          <button className="primary full" onClick={saveManual}>Add account</button>
          <button className="text-button" onClick={back}>Back</button>
        </div>}

        {mode === 'scan' && <div className="scanner">
          <div className="camera-frame"><video ref={videoRef} muted playsInline /><span className="corner tl" /><span className="corner tr" /><span className="corner bl" /><span className="corner br" /><div className="scan-line" /></div>
          <p>{kind === 'other' ? 'Position the QR code inside the frame' : 'Scan the verification-code QR from the Microsoft setup page'}</p>
          {notice && <p className={notice.tone === 'info' ? 'notice info' : 'error'}>{notice.text}</p>}
          <label className="upload-button">Choose QR image<input type="file" accept="image/*" onChange={(e) => scanFile(e.target.files?.[0])} /></label>
          {kind === 'other' && <button className="text-button" onClick={() => { controls.current?.stop(); setNotice(null); setMode('manual') }}>Enter secret key instead</button>}
          <button className="text-button" onClick={back}>Back</button>
        </div>}
      </section>
    </div>
  )
}

export default function App() {
  const [accounts, setAccounts] = useState<Account[]>(loadAccounts)
  const [tick, setTick] = useState(0)
  const [adding, setAdding] = useState(false)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | 'microsoft' | 'other'>('all')

  useEffect(() => {
    const timer = window.setInterval(() => setTick((value) => value + 1), 1000)
    return () => window.clearInterval(timer)
  }, [])
  useEffect(() => localStorage.setItem(STORAGE_KEY, JSON.stringify(accounts)), [accounts])

  const hasMicrosoft = accounts.some((account) => resolveKind(account) !== 'other')
  const hasOther = accounts.some((account) => resolveKind(account) === 'other')
  const visible = useMemo(() => {
    const normalized = query.toLowerCase().trim()
    return accounts.filter((account) => {
      const kind = resolveKind(account)
      const matchesFilter = filter === 'all' || (filter === 'microsoft' ? kind !== 'other' : kind === 'other')
      const matchesQuery = !normalized || `${account.issuer} ${account.label}`.toLowerCase().includes(normalized)
      return matchesFilter && matchesQuery
    })
  }, [accounts, query, filter])

  const addAccount = (account: Account) => {
    if (accounts.some((item) => item.secret === account.secret && item.label.toLowerCase() === account.label.toLowerCase())) {
      return 'That account is already in Keyra'
    }
    setAccounts((current) => [account, ...current])
    setAdding(false)
  }
  const deleteAccount = (account: Account) => {
    if (window.confirm(`Remove ${account.issuer} from Keyra? You may lose access if you do not have another sign-in method.`)) {
      setAccounts((current) => current.filter((item) => item.id !== account.id))
    }
  }

  return (
    <main>
      <header className="topbar">
        <a className="brand" href="/" aria-label="Keyra home"><span><Icon name="key" size={21} /></span>keyra</a>
        <button className="header-add" onClick={() => setAdding(true)}><Icon name="plus" size={18} />Add account</button>
      </header>

      <div className="content">
        <section className="intro">
          <div><span className="eyebrow">Authenticator</span><h1>Your sign-in codes</h1><p>Microsoft personal, work or school, and other accounts.</p></div>
          {accounts.length > 3 && <input className="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search accounts" aria-label="Search accounts" />}
        </section>

        {accounts.length === 0 ? <section className="empty-state">
          <div className="empty-art"><div className="orb one" /><div className="orb two" /><span className="phone"><i /><b>● ● ●</b></span><span className="spark">✦</span></div>
          <h2>Add a Microsoft sign-in</h2>
          <p>Use Keyra when Microsoft asks for a verification code, and keep any other authenticator accounts here too.</p>
          <button className="primary" onClick={() => setAdding(true)}><Icon name="plus" size={19} />Add your first account</button>
          <span className="local-note"><Icon name="shield" size={16} />Stored only on this device</span>
        </section> : <section className="accounts" aria-live="polite">
          {hasMicrosoft && hasOther && <div className="filter-row">
            <button aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>All</button>
            <button aria-pressed={filter === 'microsoft'} onClick={() => setFilter('microsoft')}>Microsoft</button>
            <button aria-pressed={filter === 'other'} onClick={() => setFilter('other')}>Other</button>
          </div>}
          <div className="section-label"><span>{visible.length} {visible.length === 1 ? 'account' : 'accounts'}</span><span>Codes refresh automatically</span></div>
          <div className="card-grid">{visible.map((account) => <CodeCard key={account.id} account={account} tick={tick} onDelete={() => deleteAccount(account)} />)}</div>
          {visible.length === 0 && <p className="no-results">No accounts match “{query}”.</p>}
        </section>}
      </div>

      <footer><span><Icon name="shield" size={15} />On-device storage</span><span>Keyra never sends or backs up your codes</span></footer>
      {adding && <AddSheet onClose={() => setAdding(false)} onAdd={addAccount} />}
    </main>
  )
}
