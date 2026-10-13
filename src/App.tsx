import { useEffect, useMemo, useRef, useState } from 'react'
import { BrowserQRCodeReader, type IScannerControls } from '@zxing/browser'
import { type Account, cleanSecret, generateTotp, isValidSecret, parseOtpUri } from './totp'

const STORAGE_KEY = 'keyra-accounts-v1'

type IconName = 'plus' | 'scan' | 'key' | 'copy' | 'check' | 'trash' | 'x' | 'shield'

const iconPaths: Record<IconName, React.ReactNode> = {
  plus: <><path d="M12 5v14M5 12h14" /></>,
  scan: <><path d="M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3" /><path d="M7 12h10" /></>,
  key: <><circle cx="8.5" cy="15.5" r="4.5" /><path d="m12 12 8-8M17 7l3 3M14 10l3 3" /></>,
  copy: <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3" /></>,
  check: <><path d="m5 12 4 4L19 6" /></>,
  trash: <><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5" /></>,
  x: <><path d="m6 6 12 12M18 6 6 18" /></>,
  shield: <><path d="M12 3 5 6v5c0 4.6 2.8 8 7 10 4.2-2 7-5.4 7-10V6l-7-3Z" /><path d="m9 12 2 2 4-4" /></>,
}

function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{iconPaths[name]}</svg>
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

function CodeCard({ account, tick, onDelete }: { account: Account; tick: number; onDelete: () => void }) {
  const [result, setResult] = useState({ code: '••••••', remaining: account.period })
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    generateTotp(account).then(setResult).catch(() => setResult({ code: 'Invalid', remaining: 0 }))
  }, [account, tick])

  const copy = async () => {
    await navigator.clipboard.writeText(result.code)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1400)
  }
  const midpoint = Math.ceil(result.code.length / 2)
  const progress = (result.remaining / account.period) * 100

  return (
    <article className="code-card">
      <div className="account-row">
        <div className="account-mark" style={{ background: colorFor(account.issuer) }}>{initials(account.issuer)}</div>
        <div className="account-meta">
          <strong>{account.issuer}</strong>
          <span>{account.label}</span>
        </div>
        <button className="icon-button delete" onClick={onDelete} aria-label={`Delete ${account.issuer}`}><Icon name="trash" size={18} /></button>
      </div>
      <div className="code-row">
        <button className="code" onClick={copy} aria-label="Copy one-time code">
          <span>{result.code.slice(0, midpoint)}</span><span>{result.code.slice(midpoint)}</span>
        </button>
        <button className={`copy-button ${copied ? 'copied' : ''}`} onClick={copy}>
          <Icon name={copied ? 'check' : 'copy'} size={19} />{copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <div className="timer-row">
        <div className="timer-track"><div style={{ width: `${progress}%` }} /></div>
        <span>{result.remaining}s</span>
      </div>
    </article>
  )
}

function AddSheet({ onClose, onAdd }: { onClose: () => void; onAdd: (account: Account) => void }) {
  const [mode, setMode] = useState<'choice' | 'manual' | 'scan'>('choice')
  const [issuer, setIssuer] = useState('')
  const [label, setLabel] = useState('')
  const [secret, setSecret] = useState('')
  const [error, setError] = useState('')
  const videoRef = useRef<HTMLVideoElement>(null)
  const controls = useRef<IScannerControls | null>(null)

  const saveParsed = (value: string) => {
    try {
      const parsed = parseOtpUri(value)
      onAdd({ ...parsed, id: crypto.randomUUID(), createdAt: Date.now() })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to read that code')
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
        saveParsed(result.getText())
      }
    }).then((value) => { controls.current = value }).catch(() => {
      setError('Camera access was unavailable. You can choose a QR image instead.')
    })
    return () => { active = false; controls.current?.stop() }
  }, [mode])

  const saveManual = () => {
    if (!issuer.trim() || !label.trim()) {
      setError('Add a service and account name')
      return
    }
    if (!isValidSecret(secret)) {
      setError('Enter a valid Base32 setup key')
      return
    }
    onAdd({
      id: crypto.randomUUID(),
      issuer: issuer.trim(),
      label: label.trim(),
      secret: cleanSecret(secret),
      algorithm: 'SHA-1',
      digits: 6,
      period: 30,
      createdAt: Date.now(),
    })
  }

  const scanFile = async (file?: File) => {
    if (!file) return
    try {
      controls.current?.stop()
      const url = URL.createObjectURL(file)
      const result = await new BrowserQRCodeReader().decodeFromImageUrl(url)
      URL.revokeObjectURL(url)
      saveParsed(result.getText())
    } catch {
      setError('No authenticator QR code was found in that image')
    }
  }

  return (
    <div className="sheet-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
        <div className="sheet-handle" />
        <header className="sheet-header">
          <div>
            <span className="eyebrow">New account</span>
            <h2 id="sheet-title">{mode === 'choice' ? 'Add a sign-in' : mode === 'scan' ? 'Scan QR code' : 'Enter setup key'}</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </header>

        {mode === 'choice' && <div className="add-options">
          <button onClick={() => setMode('scan')}><span className="option-icon lime"><Icon name="scan" size={24} /></span><span><strong>Scan a QR code</strong><small>Use your camera or a saved image</small></span><b>→</b></button>
          <button onClick={() => setMode('manual')}><span className="option-icon sand"><Icon name="key" size={24} /></span><span><strong>Enter a setup key</strong><small>Type the details provided by the service</small></span><b>→</b></button>
          <div className="privacy-note"><Icon name="shield" size={18} /><span>Your setup keys and codes never leave this device.</span></div>
        </div>}

        {mode === 'manual' && <div className="form">
          <label>Service<input autoFocus value={issuer} onChange={(e) => setIssuer(e.target.value)} placeholder="e.g. GitHub" autoComplete="off" /></label>
          <label>Account<input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="name@example.com" autoComplete="off" /></label>
          <label>Setup key<input className="secret-input" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="JBSW Y3DP EHPK 3PXP" autoCapitalize="characters" autoComplete="off" /></label>
          {error && <p className="error">{error}</p>}
          <button className="primary full" onClick={saveManual}>Add account</button>
          <button className="text-button" onClick={() => { setMode('choice'); setError('') }}>Back to options</button>
        </div>}

        {mode === 'scan' && <div className="scanner">
          <div className="camera-frame"><video ref={videoRef} muted playsInline /><span className="corner tl" /><span className="corner tr" /><span className="corner bl" /><span className="corner br" /><div className="scan-line" /></div>
          <p>Position the QR code inside the frame</p>
          {error && <p className="error">{error}</p>}
          <label className="upload-button">Choose QR image<input type="file" accept="image/*" onChange={(e) => scanFile(e.target.files?.[0])} /></label>
          <button className="text-button" onClick={() => { controls.current?.stop(); setMode('choice'); setError('') }}>Back to options</button>
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

  useEffect(() => {
    const timer = window.setInterval(() => setTick((value) => value + 1), 1000)
    return () => window.clearInterval(timer)
  }, [])
  useEffect(() => localStorage.setItem(STORAGE_KEY, JSON.stringify(accounts)), [accounts])

  const visible = useMemo(() => {
    const normalized = query.toLowerCase().trim()
    return normalized ? accounts.filter((a) => `${a.issuer} ${a.label}`.toLowerCase().includes(normalized)) : accounts
  }, [accounts, query])

  const addAccount = (account: Account) => {
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
          <div><span className="eyebrow">Authenticator</span><h1>Your sign-in codes</h1><p>Secure, private, and ready when you are.</p></div>
          {accounts.length > 3 && <input className="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search accounts" aria-label="Search accounts" />}
        </section>

        {accounts.length === 0 ? <section className="empty-state">
          <div className="empty-art"><div className="orb one" /><div className="orb two" /><span className="phone"><i /><b>● ● ●</b></span><span className="spark">✦</span></div>
          <h2>Let’s add your first account</h2>
          <p>Scan the QR code shown by a service when you turn on two-factor authentication.</p>
          <button className="primary" onClick={() => setAdding(true)}><Icon name="scan" size={19} />Add your first account</button>
          <span className="local-note"><Icon name="shield" size={16} />Stored only on this device</span>
        </section> : <section className="accounts" aria-live="polite">
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
