import { useEffect, useMemo, useState } from 'react'
import { api, TV } from '../lib/api'
import { useToast } from '../components/Toast'
import { useWS } from '../lib/hooks'

// ── SAWSUBE palette ─────────────────────────────────────────────────────────
const C = {
  bg: '#0F1923',
  card: '#1E2A35',
  fg: '#F4F1ED',
  muted: '#A09890',
  accent: '#C8612A',
  ok: '#4A7C5F',
  warn: '#C49A3C',
  err: '#A33228',
  border: '#1E2A35',
}

// ── Types ───────────────────────────────────────────────────────────────────
type ScannedApp = {
  package_id: string
  app_name: string
  description: string | null
  category: string
  safety: 'safe' | 'optional' | 'caution' | 'system' | 'unknown'
  safe_to_remove: boolean
  never_remove: boolean
  frame_tv_warning: boolean
  notes: string | null
  known: boolean
}
type ScanResult = {
  tv_id: number
  total_apps: number
  known_apps: number
  safe_count: number
  optional_count: number
  caution_count: number
  system_count: number
  unknown_count: number
  apps: ScannedApp[]
}
type ProgressMsg = {
  type: 'debloat_progress'
  tv_id: number
  step: 'connecting' | 'removing' | 'done' | 'error'
  package_id: string | null
  app_name: string | null
  message: string
  current: number
  total: number
  progress: number
}
type LogEntry = {
  id: number
  tv_id: number
  package_id: string
  app_name: string
  category: string | null
  removed_at: string
  success: boolean
  error_message: string | null
  restored_at: string | null
}
type JobResp = { started: boolean; job_id: string; count: number }

const SAFETY_COLORS: Record<string, string> = {
  safe: C.ok, optional: C.warn, caution: C.accent, system: C.err, unknown: C.muted,
}
const SAFETY_LABEL: Record<string, string> = {
  safe: '✅ Safe', optional: '🟡 Optional', caution: '⚠️ Caution',
  system: '🚫 System', unknown: 'ℹ️ Unknown',
}

export default function Debloat() {
  const { push } = useToast()
  const [tvs, setTvs] = useState<TV[]>([])
  const [tvId, setTvId] = useState<number | null>(null)
  const [scan, setScan] = useState<ScanResult | null>(null)
  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  const [scanAt, setScanAt] = useState<number | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [filterCat, setFilterCat] = useState<string>('All')
  const [search, setSearch] = useState('')
  const [showProtected, setShowProtected] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<ProgressMsg | null>(null)
  const [progressLog, setProgressLog] = useState<ProgressMsg[]>([])
  const [logEntries, setLogEntries] = useState<LogEntry[]>([])
  const [logOpen, setLogOpen] = useState(false)
  const [logPage, setLogPage] = useState(0)

  useEffect(() => {
    document.title = 'SAWSUBE — Debloat'
    api.get<TV[]>('/api/tvs').then((list) => {
      setTvs(list)
      if (list[0]) setTvId(list[0].id)
    }).catch((e) => push({ type: 'error', text: 'Failed to load TVs: ' + e.message }))
  }, [])

  useEffect(() => { if (tvId !== null) loadLog(tvId) }, [tvId])

  useWS((m) => {
    if (m?.type !== 'debloat_progress') return
    setProgress(m)
    setProgressLog((l) => [...l.slice(-200), m])
    if (m.step === 'done' || m.step === 'error') {
      setRunning(false)
      if (tvId !== null) loadLog(tvId)
      if (m.step === 'done') push({ type: 'success', text: m.message })
      else push({ type: 'error', text: m.message })
    }
  })

  const tv = useMemo(() => tvs.find((t) => t.id === tvId) || null, [tvs, tvId])
  const isFrameTV = useMemo(() => {
    if (!tv) return true // be conservative
    if (!tv.model) return true
    return /LS\d/i.test(tv.model)
  }, [tv])

  async function loadLog(id: number) {
    try {
      const rows = await api.get<LogEntry[]>(`/api/debloat/${id}/log`)
      setLogEntries(rows)
    } catch (e: any) {
      // silent — log endpoint failure shouldn't block UI
    }
  }

  async function doScan() {
    if (tvId === null) return
    setScanning(true); setScanError(null); setScan(null); setSelected(new Set())
    try {
      const r = await api.get<ScanResult>(`/api/debloat/${tvId}/scan`)
      setScan(r); setScanAt(Date.now())
    } catch (e: any) {
      setScanError(e.message || String(e))
    } finally {
      setScanning(false)
    }
  }

  function toggleApp(pid: string, never: boolean) {
    if (never) return
    setSelected((s) => {
      const n = new Set(s)
      if (n.has(pid)) n.delete(pid); else n.add(pid)
      return n
    })
  }

  function selectAllSafe() {
    if (!scan) return
    const ids = scan.apps.filter((a) => a.safety === 'safe' && !a.never_remove).map((a) => a.package_id)
    setSelected(new Set(ids))
  }

  function clearSelection() { setSelected(new Set()) }

  const categories = useMemo(() => {
    if (!scan) return ['All']
    const s = new Set(scan.apps.map((a) => a.category || 'Unknown'))
    return ['All', ...Array.from(s).sort()]
  }, [scan])

  const visibleApps = useMemo(() => {
    if (!scan) return []
    const q = search.trim().toLowerCase()
    return scan.apps.filter((a) => {
      if (!showProtected && (a.never_remove || a.safety === 'system')) return false
      if (filterCat !== 'All' && a.category !== filterCat) return false
      if (q) {
        const hay = (a.app_name + ' ' + a.package_id).toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [scan, filterCat, search, showProtected])

  async function startRemoval() {
    if (tvId === null || selected.size === 0) return
    setConfirming(false); setRunning(true)
    setProgress(null); setProgressLog([])
    try {
      const r = await api.post<JobResp>(`/api/debloat/${tvId}/remove`, {
        package_ids: Array.from(selected),
      })
      push({ type: 'info', text: `Started removal of ${r.count} apps…` })
      setSelected(new Set())
    } catch (e: any) {
      push({ type: 'error', text: 'Failed to start: ' + e.message })
      setRunning(false)
    }
  }

  async function markRestored(logId: number) {
    try {
      await api.post(`/api/debloat/log/${logId}/restore`)
      if (tvId !== null) loadLog(tvId)
      push({ type: 'success', text: 'Marked as restored.' })
    } catch (e: any) {
      push({ type: 'error', text: e.message })
    }
  }

  return (
    <div className="space-y-4" style={{ color: C.fg }}>
      {/* ── Header ─────────────────────────────────────────── */}
      <div>
        <h1 className="text-2xl" style={{ color: C.fg, fontFamily: 'var(--font-display)', letterSpacing: '0.04em' }}>
          TV Debloat Utility
        </h1>
        <div style={{ color: C.muted }} className="text-sm">
          Remove bloatware, tracking services, and unused apps from your Samsung TV.
          All removals are logged. Firmware updates may reinstall some apps.
        </div>
      </div>

      {/* ── Section 1 — Scan ───────────────────────────────── */}
      <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, padding: 16 }}>
        <div className="flex items-center gap-3 flex-wrap">
          <span style={{ color: C.fg, fontWeight: 600 }}>📡 TV Scan</span>
          <select
            value={tvId ?? ''}
            onChange={(e) => setTvId(e.target.value ? Number(e.target.value) : null)}
            style={{ background: C.card, color: C.fg, border: `1px solid ${C.border}`, padding: '6px 10px', borderRadius: 4 }}
          >
            {tvs.map((t) => (
              <option key={t.id} value={t.id}>{t.name} ({t.ip})</option>
            ))}
          </select>
          <button
            disabled={scanning || tvId === null}
            onClick={doScan}
            style={{
              background: C.accent, color: C.fg, border: 'none',
              padding: '8px 16px', borderRadius: 4, cursor: scanning ? 'wait' : 'pointer',
              opacity: scanning ? 0.6 : 1,
            }}
          >
            {scanning ? 'Scanning…' : 'Scan TV 🔍'}
          </button>
          {scanAt && !scanning && (
            <span style={{ color: C.muted, fontSize: 13 }}>
              Last scan: {new Date(scanAt).toLocaleTimeString()}
            </span>
          )}
        </div>
        {scanError && (
          <div style={{ marginTop: 12, padding: 12, background: C.err, color: C.fg, borderRadius: 4 }}>
            <strong>Scan failed:</strong> {scanError}
            <div style={{ marginTop: 6, fontSize: 13 }}>
              Tip: Tizen Studio (sdb) must be installed. Configure it in the TizenBrew page first.
            </div>
          </div>
        )}
        {scan && (
          <div style={{ marginTop: 12, fontSize: 14, color: C.muted }}>
            <strong style={{ color: C.fg }}>{scan.total_apps}</strong> apps in database •{' '}
            <span style={{ color: C.ok }}>✅ {scan.safe_count} safe</span> •{' '}
            <span style={{ color: C.warn }}>🟡 {scan.optional_count} optional</span> •{' '}
            <span style={{ color: C.err }}>🚫 {scan.system_count} protected</span>
          </div>
        )}
        <div style={{ marginTop: 12, padding: 10, background: C.card, borderRadius: 4, fontSize: 13, color: C.muted }}>
          ℹ️ <strong style={{ color: C.fg }}>About this scan:</strong> Samsung consumer TVs lock down
          live app enumeration (<code>intershell</code> disabled). The list below is SAWSUBE's curated
          knowledge base of common bloatware. When you click <em>Remove</em>, each package is sent to
          the TV — those that are installed and accept removal will be uninstalled, others will be
          reported as "not installed" or "rejected" in the log.
        </div>
      </div>

      {/* ── Removal progress (replaces app list while running) ────── */}
      {running && (
        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: 16 }}>
          <div style={{ color: C.fg, fontWeight: 600, marginBottom: 8 }}>Removing apps…</div>
          <div style={{ width: '100%', height: 10, background: C.bg, borderRadius: 5, overflow: 'hidden', border: `1px solid ${C.border}` }}>
            <div style={{ width: `${progress?.progress ?? 0}%`, height: '100%', background: C.accent, transition: 'width 0.3s' }} />
          </div>
          <div style={{ marginTop: 8, color: C.fg, fontSize: 14 }}>
            {progress?.message || 'Starting…'}
          </div>
          <div style={{ marginTop: 12, maxHeight: 240, overflow: 'auto', fontSize: 12, fontFamily: 'monospace', color: C.muted }}>
            {progressLog.map((p, i) => (
              <div key={i}>
                [{p.step}] {p.message}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Section 2 — App List ────────────────────────────── */}
      {scan && !running && (
        <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, padding: 16 }}>
          <div className="flex items-center gap-2 flex-wrap" style={{ marginBottom: 12 }}>
            <select
              value={filterCat}
              onChange={(e) => setFilterCat(e.target.value)}
              style={{ background: C.card, color: C.fg, border: `1px solid ${C.border}`, padding: '6px 10px', borderRadius: 4 }}
            >
              {categories.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <input
              type="text"
              placeholder="🔍 Search apps…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ flex: '1 1 200px', background: C.card, color: C.fg, border: `1px solid ${C.border}`, padding: '6px 10px', borderRadius: 4 }}
            />
            <label style={{ color: C.muted, fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={showProtected} onChange={(e) => setShowProtected(e.target.checked)} />
              Show protected
            </label>
            <button
              onClick={selectAllSafe}
              style={{ background: C.ok, color: C.fg, border: 'none', padding: '6px 12px', borderRadius: 4, cursor: 'pointer', fontSize: 13 }}
            >
              Select All Safe
            </button>
            <button
              onClick={clearSelection}
              style={{ background: C.card, color: C.fg, border: `1px solid ${C.border}`, padding: '6px 12px', borderRadius: 4, cursor: 'pointer', fontSize: 13 }}
            >
              Clear
            </button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {visibleApps.map((a) => {
              const sel = selected.has(a.package_id)
              const protectedApp = a.never_remove
              return (
                <div
                  key={a.package_id}
                  onClick={() => toggleApp(a.package_id, protectedApp)}
                  style={{
                    display: 'flex', alignItems: 'flex-start', gap: 10,
                    padding: 10, borderRadius: 4,
                    background: sel ? `${C.accent}33` : C.card,
                    border: `1px solid ${sel ? C.accent : C.border}`,
                    cursor: protectedApp ? 'not-allowed' : 'pointer',
                    opacity: protectedApp ? 0.7 : 1,
                  }}
                >
                  <div style={{ fontSize: 18, lineHeight: 1, marginTop: 2 }}>
                    {protectedApp ? '🔒' : (sel ? '☑' : '☐')}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="flex items-center gap-2 flex-wrap">
                      <strong style={{ color: C.fg }}>{a.app_name}</strong>
                      <span style={{
                        padding: '2px 8px', borderRadius: 999, fontSize: 11,
                        background: SAFETY_COLORS[a.safety] + '33',
                        color: SAFETY_COLORS[a.safety],
                        border: `1px solid ${SAFETY_COLORS[a.safety]}`,
                      }}>
                        {a.category}
                      </span>
                      <span style={{ fontSize: 11, color: SAFETY_COLORS[a.safety] }}>
                        {SAFETY_LABEL[a.safety]}
                      </span>
                      {a.frame_tv_warning && isFrameTV && (
                        <span style={{ fontSize: 11, color: C.warn }}>⚠️ Frame TV</span>
                      )}
                      {!a.known && (
                        <span title="Not in SAWSUBE database — proceed with caution" style={{ color: C.muted, fontSize: 11 }}>
                          ℹ️ Unknown
                        </span>
                      )}
                    </div>
                    {a.description && (
                      <div style={{ color: C.muted, fontSize: 13, marginTop: 2 }}>{a.description}</div>
                    )}
                    <div style={{ color: C.muted, fontSize: 11, fontFamily: 'monospace', marginTop: 2 }}>
                      {a.package_id}
                    </div>
                    {a.notes && (
                      <div style={{ color: C.warn, fontSize: 12, marginTop: 4 }}>{a.notes}</div>
                    )}
                  </div>
                </div>
              )
            })}
            {visibleApps.length === 0 && (
              <div style={{ color: C.muted, padding: 24, textAlign: 'center' }}>No apps match filter.</div>
            )}
          </div>
        </div>
      )}

      {/* ── Sticky Removal Action Bar ──────────────────────── */}
      {selected.size > 0 && !running && (
        <div style={{
          position: 'sticky', bottom: 0, zIndex: 10,
          background: C.bg, border: `1px solid ${C.accent}`, borderRadius: 8, padding: 12,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
          boxShadow: '0 -4px 12px rgba(0,0,0,0.3)',
        }}>
          <div>
            <strong style={{ color: C.fg }}>{selected.size} apps selected</strong>
            <span style={{ color: C.warn, marginLeft: 12, fontSize: 13 }}>
              ⚠️ Some apps may not be removable on locked-down consumer TVs.
            </span>
          </div>
          <div className="flex gap-2">
            <button
              onClick={clearSelection}
              style={{ background: C.card, color: C.fg, border: `1px solid ${C.border}`, padding: '8px 16px', borderRadius: 4, cursor: 'pointer' }}
            >
              Cancel
            </button>
            <button
              onClick={() => setConfirming(true)}
              style={{ background: C.err, color: C.fg, border: 'none', padding: '8px 16px', borderRadius: 4, cursor: 'pointer' }}
            >
              🗑️ Remove Selected
            </button>
          </div>
        </div>
      )}

      {/* ── Confirmation modal ────────────────────────────── */}
      {confirming && scan && (
        <div
          onClick={() => setConfirming(false)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 100,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, padding: 20,
              maxWidth: 560, width: '100%',
            }}
          >
            <h2 style={{ color: C.fg, marginBottom: 12 }}>
              Remove {selected.size} apps from {tv?.name}?
            </h2>
            <div style={{ color: C.muted, fontSize: 14, marginBottom: 12 }}>
              {Array.from(selected).slice(0, 10).map((pid) => {
                const a = scan.apps.find((x) => x.package_id === pid)
                return <div key={pid}>• {a?.app_name || pid}</div>
              })}
              {selected.size > 10 && <div>…and {selected.size - 10} more</div>}
            </div>
            <div style={{ background: C.warn + '33', border: `1px solid ${C.warn}`, padding: 10, borderRadius: 4, color: C.fg, fontSize: 13, marginBottom: 12 }}>
              <strong>Note:</strong> Firmware updates from Samsung may reinstall some of these apps.
              Consumer TVs with locked shells may also reject removal of pre-installed system apps.
            </div>
            {Array.from(selected).some((pid) => scan.apps.find((a) => a.package_id === pid)?.frame_tv_warning) && isFrameTV && (
              <div style={{ background: C.err + '44', border: `1px solid ${C.err}`, padding: 10, borderRadius: 4, color: C.fg, fontSize: 13, marginBottom: 12 }}>
                ⛔ <strong>Frame TV warning:</strong> One or more selected apps are flagged as critical
                for Frame TV functionality. Please double-check your selection.
              </div>
            )}
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setConfirming(false)}
                style={{ background: C.card, color: C.fg, border: `1px solid ${C.border}`, padding: '8px 16px', borderRadius: 4, cursor: 'pointer' }}
              >
                Cancel
              </button>
              <button
                onClick={startRemoval}
                style={{ background: C.err, color: C.fg, border: 'none', padding: '8px 16px', borderRadius: 4, cursor: 'pointer' }}
              >
                I understand, remove them
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Section 3 — Removal Log ───────────────────────── */}
      <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, padding: 16 }}>
        <button
          onClick={() => setLogOpen(!logOpen)}
          style={{ background: 'none', border: 'none', color: C.fg, cursor: 'pointer', fontSize: 16, fontWeight: 600, padding: 0 }}
        >
          {logOpen ? '▼' : '▶'} Removal History ({logEntries.length} entries)
        </button>
        {logOpen && (
          <div style={{ marginTop: 12, overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: 13, color: C.fg, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ color: C.muted, textAlign: 'left', borderBottom: `1px solid ${C.border}` }}>
                  <th style={{ padding: 6 }}>App</th>
                  <th style={{ padding: 6 }}>Package</th>
                  <th style={{ padding: 6 }}>Category</th>
                  <th style={{ padding: 6 }}>Removed</th>
                  <th style={{ padding: 6 }}>Result</th>
                  <th style={{ padding: 6 }}>Restored</th>
                </tr>
              </thead>
              <tbody>
                {logEntries.slice(logPage * 20, logPage * 20 + 20).map((e) => (
                  <tr key={e.id} style={{ borderBottom: `1px solid ${C.border}` }}>
                    <td style={{ padding: 6 }}>{e.app_name}</td>
                    <td style={{ padding: 6, fontFamily: 'monospace', color: C.muted, fontSize: 11 }}>{e.package_id}</td>
                    <td style={{ padding: 6, color: C.muted }}>{e.category || '—'}</td>
                    <td style={{ padding: 6, color: C.muted }}>{new Date(e.removed_at).toLocaleString()}</td>
                    <td style={{ padding: 6, color: e.success ? C.ok : C.err }} title={e.error_message || ''}>
                      {e.success ? '✅ Removed' : `❌ ${e.error_message || 'Failed'}`}
                    </td>
                    <td style={{ padding: 6 }}>
                      {e.restored_at ? (
                        <span style={{ color: C.muted, fontSize: 12 }}>{new Date(e.restored_at).toLocaleDateString()}</span>
                      ) : (
                        <button
                          onClick={() => markRestored(e.id)}
                          style={{ background: C.card, color: C.fg, border: `1px solid ${C.border}`, padding: '3px 8px', borderRadius: 3, cursor: 'pointer', fontSize: 11 }}
                          title="Marks as restored in your records. Does not actually reinstall."
                        >
                          Mark Restored
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {logEntries.length === 0 && (
                  <tr><td colSpan={6} style={{ padding: 16, textAlign: 'center', color: C.muted }}>No removals logged yet.</td></tr>
                )}
              </tbody>
            </table>
            {logEntries.length > 20 && (
              <div className="flex gap-2 justify-center" style={{ marginTop: 8 }}>
                <button
                  disabled={logPage === 0}
                  onClick={() => setLogPage(p => Math.max(0, p - 1))}
                  style={{ background: C.card, color: C.fg, border: `1px solid ${C.border}`, padding: '4px 10px', borderRadius: 3, cursor: 'pointer', opacity: logPage === 0 ? 0.4 : 1 }}
                >
                  ← Prev
                </button>
                <span style={{ color: C.muted, alignSelf: 'center', fontSize: 12 }}>
                  Page {logPage + 1} of {Math.ceil(logEntries.length / 20)}
                </span>
                <button
                  disabled={(logPage + 1) * 20 >= logEntries.length}
                  onClick={() => setLogPage(p => p + 1)}
                  style={{ background: C.card, color: C.fg, border: `1px solid ${C.border}`, padding: '4px 10px', borderRadius: 3, cursor: 'pointer' }}
                >
                  Next →
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
