import { useState, useEffect, useCallback, useRef } from 'react'
import Papa from 'papaparse'
import {
  CheckCircle, XCircle, Clock, Plus, Trash2, ExternalLink,
  RefreshCw, ChevronDown, ChevronUp, Search,
  Download, Settings, X, AlertCircle, SkipForward, Layers,
  Upload, Tag, FileText, ChevronRight, Filter, BarChart2,
  Radio, User, UserCheck, Copy
} from 'lucide-react'
import { supabase } from './lib/supabase.js'

const CHART_COLORS = ['#7B6EF6', '#34D9B3', '#F5C243', '#3B9EFF', '#F07A6E', '#A89BF8', '#22c97a', '#FF8C69']
import './App.css'

// GitHub config stays in localStorage (contains sensitive tokens)
const GITHUB_CONFIG_KEY = 'beacon_github_config'
const DEFAULT_GITHUB_CONFIG = { url: '', branch: 'main', file: '', folders: '', token: '', mode: 'folders' }

function loadGithubConfig() {
  try {
    const raw = localStorage.getItem(GITHUB_CONFIG_KEY)
    if (!raw) return { ...DEFAULT_GITHUB_CONFIG }
    return { ...DEFAULT_GITHUB_CONFIG, ...JSON.parse(raw) }
  } catch { return { ...DEFAULT_GITHUB_CONFIG } }
}

function saveGithubConfig(cfg) {
  localStorage.setItem(GITHUB_CONFIG_KEY, JSON.stringify(cfg))
}

// Parse owner + repo from a GitHub URL
function parseGithubRepo(url) {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\s*$/)
  if (!m) throw new Error('Cannot parse GitHub repo URL — use https://github.com/owner/repo')
  return { owner: m[1], repo: m[2].replace(/\/$/, '') }
}

const STATUS_CONFIG = {
  pass:    { label: 'Pass',    color: 'var(--green)',  icon: CheckCircle },
  fail:    { label: 'Fail',    color: 'var(--red)',    icon: XCircle     },
  skip:    { label: 'Skip',    color: 'var(--yellow)', icon: SkipForward },
  pending: { label: 'Pending', color: 'var(--text3)',  icon: Clock       },
}

const PRIORITY_CONFIG = {
  P0: { color: '#f04e6a', bg: '#f04e6a20' },
  P1: { color: '#f0b429', bg: '#f0b42920' },
  P2: { color: '#3b9eff', bg: '#3b9eff20' },
  P3: { color: 'var(--text3)', bg: 'var(--bg3)' },
}

// Map any CSV row format → standard internal shape
function normalizeTC(row) {
  return {
    id:             row['Test Case #'] || row['id'] || row['ID'] || row['Test ID'] || '',
    title:          row['Scenario'] || row['title'] || row['Title'] || row['Test Name'] || '',
    module:         row['Module'] || row['module'] || row['Category'] || row['category'] || 'Uncategorised',
    submodule:      row['Submodule'] || row['submodule'] || '',
    priority:       (row['Priority'] || row['priority'] || '').trim().toUpperCase(),
    labels:         row['Labels'] || row['labels'] || '',
    precondition:   row['Precondition'] || row['precondition'] || '',
    testSteps:      row['Test steps'] || row['Test Steps'] || row['Steps'] || '',
    expectedResult: row['Expected Result'] || row['Expected Results'] || '',
    source:         row['source_csv'] || '',
    automationStatus: row['Automation Status'] || '',
  }
}

function isCantBeAutomated(row) {
  const s = (row['Automation Status'] || '').toLowerCase().replace(/['']/g, "'")
  return s.includes("can't be automated") || s.includes("cant be automated")
}

function parseCsvText(text) {
  return new Promise((resolve, reject) => {
    Papa.parse(text, {
      header: true,
      skipEmptyLines: true,
      complete: r => resolve(r.data),
      error:    e => reject(e),
    })
  })
}

// ── Priority badge ─────────────────────────────────────────────────────────────
function PriorityBadge({ priority }) {
  if (!priority) return null
  const cfg = PRIORITY_CONFIG[priority] || PRIORITY_CONFIG.P3
  return (
    <span style={{
      fontSize: '10px', fontWeight: 700, padding: '1px 6px',
      borderRadius: '4px', background: cfg.bg, color: cfg.color,
      whiteSpace: 'nowrap', flexShrink: 0, letterSpacing: '0.02em',
    }}>
      {priority}
    </span>
  )
}

// ── Label chips ────────────────────────────────────────────────────────────────
function LabelChips({ labels, max = 0 }) {
  const tags = labels.split(/[;\n,]+/).map(s => s.trim()).filter(Boolean)
  const shown = max ? tags.slice(0, max) : tags
  const rest = tags.length - shown.length
  if (!shown.length) return null
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px', marginTop: '4px' }}>
      {shown.map(tag => (
        <span key={tag} style={{
          fontSize: '10px', padding: '1px 6px', borderRadius: '3px',
          background: 'var(--accent)15', color: 'var(--accent2)',
          border: '1px solid var(--accent)25',
        }}>
          {tag}
        </span>
      ))}
      {rest > 0 && <span style={{ fontSize: '10px', color: 'var(--text3)' }}>+{rest} more</span>}
    </div>
  )
}

// ── Root App ───────────────────────────────────────────────────────────────────
export default function App() {
  const [releases, setReleases]               = useState([])
  const [githubConfig, setGithubConfig]       = useState(loadGithubConfig)
  const [dbLoading, setDbLoading]             = useState(true)
  const [activeView, setActiveView]           = useState('releases')
  const [activeReleaseId, setActiveReleaseId] = useState(null)
  const [testCases, setTestCases]             = useState([])
  const [csvSources, setCsvSources]           = useState([])
  const [loadingCsv, setLoadingCsv]           = useState(false)
  const [loadProgress, setLoadProgress]       = useState('')
  const [csvError, setCsvError]               = useState('')
  const [searchQ, setSearchQ]                 = useState('')
  const [showNewRelease, setShowNewRelease]   = useState(false)
  const [newRelease, setNewRelease]           = useState({ name: '', jiraTicket: '', jiraUrl: '', description: '', qaResource: '', reviewer: '', releaseDate: '', environment: 'Staging' })
  const notesTimerRef                         = useRef({})

  // Load all releases + their test cases from Supabase on mount
  useEffect(() => { loadFromSupabase() }, [])

  const loadFromSupabase = async () => {
    setDbLoading(true)
    let autoSyncConfig = null
    try {
      const { data: relData, error: rErr } = await supabase
        .from('beacon_releases').select('*').order('created_at', { ascending: false })
      if (rErr) throw rErr

      const { data: tcData, error: tcErr } = await supabase
        .from('beacon_test_cases').select('*')
      if (tcErr) throw tcErr

      setReleases(relData.map(r => ({
        id: r.id,
        name: r.name,
        jiraTicket: r.jira_ticket || '',
        jiraUrl: r.jira_url || '',
        description: r.description || '',
        qaResource: r.qa_resource || '',
        reviewer: r.reviewer || '',
        releaseDate: r.release_date || '',
        environment: r.environment || 'Staging',
        checklist: r.checklist || {},
        createdAt: r.created_at,
        testCases: (tcData || [])
          .filter(tc => tc.release_id === r.id)
          .map(tc => ({
            id: tc.tc_id,
            title: tc.title,
            module: tc.module,
            submodule: tc.submodule,
            priority: tc.priority,
            labels: tc.labels,
            precondition: tc.precondition,
            testSteps: tc.test_steps,
            expectedResult: tc.expected_result,
            source: tc.source,
            status: tc.status,
            notes: tc.notes,
            updatedAt: tc.updated_at,
          })),
      })))

      // Show cached test library immediately so coverage is visible while GitHub syncs
      const { data: libData } = await supabase.from('beacon_test_library').select('*')
      if (libData?.length) {
        setTestCases(libData.map(tc => ({
          id: tc.tc_id, title: tc.title, module: tc.module,
          submodule: tc.submodule, priority: tc.priority, labels: tc.labels,
          precondition: tc.precondition, testSteps: tc.test_steps,
          expectedResult: tc.expected_result, source: tc.source,
        })))
        const sourceMap = {}
        libData.forEach(tc => {
          const s = tc.source || '(unknown)'
          if (!sourceMap[s]) sourceMap[s] = { name: s, count: 0, total: 0 }
          sourceMap[s].count++; sourceMap[s].total++
        })
        setCsvSources(Object.values(sourceMap))
      }

      // Load shared GitHub config — merge URL/branch/folders with local token
      const { data: cfgData } = await supabase.from('beacon_config').select('*')
      if (cfgData?.length) {
        const map = Object.fromEntries(cfgData.map(r => [r.key, r.value]))
        const shared = {
          url: map.github_url || '', branch: map.github_branch || 'main',
          folders: map.github_folders || '', file: map.github_file || '',
          mode: map.github_mode || 'folders',
        }
        if (shared.url) {
          const merged = { ...shared, token: loadGithubConfig().token || '' }
          setGithubConfig(merged)
          saveGithubConfig(merged)
          autoSyncConfig = merged
        }
      }
      // Fall back to local config if no shared config saved yet
      if (!autoSyncConfig) {
        const local = loadGithubConfig()
        if (local.url && (local.mode === 'folders' ? local.folders : local.file))
          autoSyncConfig = local
      }
    } catch (e) {
      console.error('Supabase load error:', e)
    } finally {
      setDbLoading(false)
    }
    // Auto-sync from GitHub in background — app is already visible with cached data
    if (autoSyncConfig?.url) fetchFromGithub(autoSyncConfig)
  }

  const saveConfigToSupabase = async (cfg) => {
    const rows = [
      { key: 'github_url',     value: cfg.url     || '' },
      { key: 'github_branch',  value: cfg.branch  || 'main' },
      { key: 'github_folders', value: cfg.folders || '' },
      { key: 'github_file',    value: cfg.file    || '' },
      { key: 'github_mode',    value: cfg.mode    || 'folders' },
    ]
    const { error } = await supabase.from('beacon_config').upsert(rows, { onConflict: 'key' })
    if (error) console.error('Failed to save config:', error)
  }

  const saveTestCasesToSupabase = async (tcs) => {
    if (!tcs.length) return
    setLoadProgress('Saving to Supabase…')
    const rows = tcs.map(tc => ({
      tc_id: tc.id, title: tc.title, module: tc.module, submodule: tc.submodule,
      priority: tc.priority, labels: tc.labels, precondition: tc.precondition,
      test_steps: tc.testSteps, expected_result: tc.expectedResult,
      source: tc.source, synced_at: new Date().toISOString(),
    }))
    const BATCH = 200
    for (let i = 0; i < rows.length; i += BATCH) {
      const { error } = await supabase.from('beacon_test_library')
        .upsert(rows.slice(i, i + BATCH), { onConflict: 'tc_id' })
      if (error) console.error('Failed to save test library:', error)
    }
  }

  const applyRows = (rows, sourceName) => {
    const filtered = rows.filter(isCantBeAutomated).map(normalizeTC)
    return { filtered, source: { name: sourceName, count: filtered.length, total: rows.length } }
  }

  const ghHeaders = (token) => token ? { Authorization: `token ${token}` } : {}

  const fetchOneFile = async (rawUrl, label, token) => {
    const res = await fetch(rawUrl, { headers: ghHeaders(token) })
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${label}`)
    const rows = await parseCsvText(await res.text())
    return applyRows(rows, label)
  }

  const fetchFolder = async (owner, repo, branch, folder, token) => {
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${folder}?ref=${branch}`
    const res = await fetch(apiUrl, { headers: ghHeaders(token) })
    if (!res.ok) {
      const msg = res.status === 403 ? `Rate-limited or private repo (add a token)` : `HTTP ${res.status}`
      throw new Error(`${folder}: ${msg}`)
    }
    const items = await res.json()
    if (!Array.isArray(items)) throw new Error(`${folder}: unexpected API response`)
    return items.filter(i => i.type === 'file' && i.name.toLowerCase().endsWith('.csv'))
  }

  const fetchFromGithub = useCallback(async (config) => {
    const cfg = config || githubConfig
    if (!cfg.url) return

    setLoadingCsv(true); setCsvError(''); setCsvSources([]); setLoadProgress('')

    try {
      const { owner, repo } = parseGithubRepo(cfg.url)
      const { branch = 'main', token = '', mode = 'folders' } = cfg
      const allTcs = []; const sources = []; const errors = []

      if (mode === 'folders') {
        const folderList = (cfg.folders || '').split('\n').map(s => s.trim()).filter(Boolean)
        if (!folderList.length) throw new Error('Enter at least one folder path in the Folders field')

        for (let fi = 0; fi < folderList.length; fi++) {
          const folder = folderList[fi]
          setLoadProgress(`Scanning ${folder}… (${fi + 1}/${folderList.length})`)
          try {
            const files = await fetchFolder(owner, repo, branch, folder, token)
            for (let ci = 0; ci < files.length; ci++) {
              const f = files[ci]
              setLoadProgress(`${folder}/${f.name} (${ci + 1}/${files.length})`)
              const { filtered, source } = await fetchOneFile(f.download_url, `${folder}/${f.name}`, token)
              allTcs.push(...filtered)
              sources.push(source)
            }
          } catch (e) {
            errors.push(e.message)
          }
        }
      } else {
        if (!cfg.file) throw new Error('Enter a CSV file path')
        setLoadProgress(`Fetching ${cfg.file}…`)
        const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${cfg.file}`
        const { filtered, source } = await fetchOneFile(rawUrl, cfg.file, token)
        allTcs.push(...filtered)
        sources.push(source)
      }

      setTestCases(allTcs)
      setCsvSources(sources)
      if (errors.length) setCsvError(errors.join('\n'))
      await saveTestCasesToSupabase(allTcs)
    } catch (e) {
      setCsvError(e.message)
    } finally {
      setLoadingCsv(false)
      setLoadProgress('')
    }
  }, [githubConfig])

  const loadLocalFiles = useCallback(async (files) => {
    if (!files?.length) return
    setLoadingCsv(true); setCsvError(''); setLoadProgress('')
    try {
      const allTcs = []; const sources = []
      for (let i = 0; i < files.length; i++) {
        const file = files[i]
        setLoadProgress(`Parsing ${file.name}… (${i + 1}/${files.length})`)
        const rows = await parseCsvText(await file.text())
        const { filtered, source } = applyRows(rows, file.name)
        allTcs.push(...filtered)
        sources.push(source)
      }
      setTestCases(allTcs)
      setCsvSources(sources)
      await saveTestCasesToSupabase(allTcs)
    } catch (e) {
      setCsvError(e.message)
    } finally {
      setLoadingCsv(false)
      setLoadProgress('')
    }
  }, [])

  const activeRelease = releases.find(r => r.id === activeReleaseId)

  const addRelease = async () => {
    if (!newRelease.name.trim()) return
    const release = { id: Date.now().toString(), ...newRelease, createdAt: new Date().toISOString(), testCases: [] }
    setReleases(p => [release, ...p])
    setNewRelease({ name: '', jiraTicket: '', jiraUrl: '', description: '', qaResource: '', reviewer: '', releaseDate: '', environment: 'Staging' })
    setShowNewRelease(false)
    setActiveReleaseId(release.id)
    setActiveView('release-detail')

    const { error } = await supabase.from('beacon_releases').insert({
      id: release.id, name: release.name,
      jira_ticket: release.jiraTicket, jira_url: release.jiraUrl,
      description: release.description, qa_resource: release.qaResource,
      reviewer: release.reviewer, created_at: release.createdAt,
      release_date: release.releaseDate || null,
      environment: release.environment || 'Staging',
      checklist: {},
    })
    if (error) console.error('Failed to save release:', error)
  }

  const deleteRelease = async (id) => {
    setReleases(p => p.filter(r => r.id !== id))
    if (activeReleaseId === id) { setActiveView('releases'); setActiveReleaseId(null) }

    const { error } = await supabase.from('beacon_releases').delete().eq('id', id)
    if (error) console.error('Failed to delete release:', error)
  }

  const cloneRelease = async (source) => {
    const cloneId = Date.now().toString()
    const cloneName = `Copy of ${source.name}`
    const clonedTcs = source.testCases.map(tc => ({ ...tc, status: 'pending', notes: '', updatedAt: null }))
    const clone = { id: cloneId, name: cloneName, jiraTicket: source.jiraTicket, jiraUrl: source.jiraUrl, description: source.description, qaResource: source.qaResource, reviewer: source.reviewer, createdAt: new Date().toISOString(), testCases: clonedTcs }

    setReleases(p => [clone, ...p])
    setActiveReleaseId(cloneId)
    setActiveView('release-detail')

    const { error: rErr } = await supabase.from('beacon_releases').insert({
      id: cloneId, name: cloneName,
      jira_ticket: source.jiraTicket, jira_url: source.jiraUrl,
      description: source.description, qa_resource: source.qaResource,
      reviewer: source.reviewer, created_at: clone.createdAt,
    })
    if (rErr) { console.error('Failed to clone release:', rErr); return }

    if (clonedTcs.length > 0) {
      const rows = clonedTcs.map(tc => ({
        release_id: cloneId, tc_id: tc.id, title: tc.title,
        module: tc.module, submodule: tc.submodule, priority: tc.priority,
        labels: tc.labels, precondition: tc.precondition,
        test_steps: tc.testSteps, expected_result: tc.expectedResult,
        source: tc.source, status: 'pending', notes: '',
      }))
      const { error: tcErr } = await supabase.from('beacon_test_cases').insert(rows)
      if (tcErr) console.error('Failed to clone test cases:', tcErr)
    }
  }

  const updateChecklist = async (releaseId, key, checked) => {
    setReleases(p => p.map(r => {
      if (r.id !== releaseId) return r
      return { ...r, checklist: { ...r.checklist, [key]: checked } }
    }))
    const rel = releases.find(r => r.id === releaseId)
    const updated = { ...(rel?.checklist || {}), [key]: checked }
    await supabase.from('beacon_releases').update({ checklist: updated }).eq('id', releaseId)
  }

  const toggleTestCase = async (releaseId, tc) => {
    const release = releases.find(r => r.id === releaseId)
    const exists = release?.testCases.find(t => t.id === tc.id)

    setReleases(p => p.map(r => {
      if (r.id !== releaseId) return r
      return {
        ...r,
        testCases: exists
          ? r.testCases.filter(t => t.id !== tc.id)
          : [...r.testCases, { ...tc, status: 'pending', notes: '', updatedAt: null }],
      }
    }))

    if (exists) {
      const { error } = await supabase.from('beacon_test_cases')
        .delete().eq('release_id', releaseId).eq('tc_id', tc.id)
      if (error) console.error('Failed to remove test case:', error)
    } else {
      const { error } = await supabase.from('beacon_test_cases').insert({
        release_id: releaseId, tc_id: tc.id, title: tc.title,
        module: tc.module, submodule: tc.submodule, priority: tc.priority,
        labels: tc.labels, precondition: tc.precondition,
        test_steps: tc.testSteps, expected_result: tc.expectedResult,
        source: tc.source, status: 'pending', notes: '',
      })
      if (error) console.error('Failed to add test case:', error)
    }
  }

  const bulkToggle = async (releaseId, tcs, add) => {
    const release = releases.find(r => r.id === releaseId)

    setReleases(p => p.map(r => {
      if (r.id !== releaseId) return r
      if (!add) {
        const ids = new Set(tcs.map(t => t.id))
        return { ...r, testCases: r.testCases.filter(t => !ids.has(t.id)) }
      }
      const existing = new Set(r.testCases.map(t => t.id))
      const toAdd = tcs.filter(t => !existing.has(t.id)).map(tc => ({ ...tc, status: 'pending', notes: '', updatedAt: null }))
      return { ...r, testCases: [...r.testCases, ...toAdd] }
    }))

    if (add) {
      const existing = new Set(release?.testCases.map(t => t.id) || [])
      const toInsert = tcs.filter(t => !existing.has(t.id)).map(tc => ({
        release_id: releaseId, tc_id: tc.id, title: tc.title,
        module: tc.module, submodule: tc.submodule, priority: tc.priority,
        labels: tc.labels, precondition: tc.precondition,
        test_steps: tc.testSteps, expected_result: tc.expectedResult,
        source: tc.source, status: 'pending', notes: '',
      }))
      if (toInsert.length) {
        const { error } = await supabase.from('beacon_test_cases').insert(toInsert)
        if (error) console.error('Failed to bulk add:', error)
      }
    } else {
      const ids = tcs.map(t => t.id)
      const { error } = await supabase.from('beacon_test_cases')
        .delete().eq('release_id', releaseId).in('tc_id', ids)
      if (error) console.error('Failed to bulk remove:', error)
    }
  }

  const updateTestStatus = async (releaseId, tcId, status) => {
    const updatedAt = new Date().toISOString()
    setReleases(p => p.map(r => r.id !== releaseId ? r : {
      ...r,
      testCases: r.testCases.map(t => t.id !== tcId ? t : { ...t, status, updatedAt }),
    }))

    const { error } = await supabase.from('beacon_test_cases')
      .update({ status, updated_at: updatedAt })
      .eq('release_id', releaseId).eq('tc_id', tcId)
    if (error) console.error('Failed to update status:', error)
  }

  const updateTestNotes = (releaseId, tcId, notes) => {
    setReleases(p => p.map(r => r.id !== releaseId ? r : {
      ...r,
      testCases: r.testCases.map(t => t.id !== tcId ? t : { ...t, notes }),
    }))

    // Debounce Supabase write — only fires 800ms after user stops typing
    const key = `${releaseId}:${tcId}`
    clearTimeout(notesTimerRef.current[key])
    notesTimerRef.current[key] = setTimeout(async () => {
      const { error } = await supabase.from('beacon_test_cases')
        .update({ notes }).eq('release_id', releaseId).eq('tc_id', tcId)
      if (error) console.error('Failed to save notes:', error)
    }, 800)
  }

  const exportRelease = (release) => {
    const rows = [
      ['Test Case ID', 'Module', 'Submodule', 'Title', 'Priority', 'Status', 'Notes', 'Updated'],
      ...release.testCases.map(t => [t.id, t.module, t.submodule, t.title, t.priority, t.status, t.notes, t.updatedAt || '']),
    ]
    const csv = rows.map(r => r.map(c => `"${(c || '').toString().replace(/"/g, '""')}"`).join(',')).join('\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
    a.download = `${release.name.replace(/\s+/g, '_')}_test_results.csv`
    a.click()
  }

  const filteredTestCases = testCases.filter(tc => {
    if (!searchQ) return true
    const q = searchQ.toLowerCase()
    return [tc.id, tc.title, tc.module, tc.submodule, tc.labels, tc.priority].some(v => (v || '').toLowerCase().includes(q))
  })

  const getStats = (release) => {
    const tcs = release.testCases
    return {
      total:   tcs.length,
      pass:    tcs.filter(t => t.status === 'pass').length,
      fail:    tcs.filter(t => t.status === 'fail').length,
      skip:    tcs.filter(t => t.status === 'skip').length,
      pending: tcs.filter(t => t.status === 'pending').length,
    }
  }

  if (dbLoading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', background: 'var(--sb-bg)' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ width: 48, height: 48, borderRadius: 14, background: 'linear-gradient(135deg, #F59E0B 0%, #D97706 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px', boxShadow: '0 0 24px rgba(245,158,11,0.5), 0 4px 12px rgba(0,0,0,0.3)' }}>
            <Radio size={22} color="#1A1033" strokeWidth={2.5} />
          </div>
          <p style={{ fontSize: '15px', fontWeight: 800, fontFamily: 'var(--font-head)', marginBottom: 6, letterSpacing: '0.18em', textTransform: 'uppercase', background: 'linear-gradient(135deg, #F59E0B 0%, #FDE68A 45%, #EDE8FF 100%)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text', filter: 'drop-shadow(0 0 10px rgba(245,158,11,0.55))' }}>Beacon</p>
          <p style={{ fontSize: '12px', color: '#4B3870', display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'center', fontFamily: 'var(--font-body)' }}>
            <RefreshCw size={12} className="spin" style={{ color: '#8B5CF6' }} /> Loading…
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="logo">
          <div className="logo-icon-wrap">
            <Radio size={18} color="#fff" strokeWidth={2.2} />
          </div>
          <div className="logo-text">
            <span className="logo-name">Beacon</span>
            <span className="logo-tagline">by Datman</span>
          </div>
        </div>

        <div className="nav-section-label">Tools</div>
        <nav className="nav">
          <button className={`nav-item ${activeView === 'releases' || activeView === 'release-detail' ? 'active' : ''}`}
            onClick={() => setActiveView('releases')}>
            <CheckCircle size={15} /> Releases
          </button>
          <button className={`nav-item ${activeView === 'coverage' ? 'active' : ''}`}
            onClick={() => setActiveView('coverage')}>
            <BarChart2 size={15} /> Coverage
          </button>
          <button className={`nav-item ${activeView === 'settings' ? 'active' : ''}`}
            onClick={() => setActiveView('settings')}>
            <Settings size={15} /> Settings
          </button>
        </nav>

        <div className="sidebar-footer">
          <span className="tc-count">
            {testCases.length > 0 ? `${testCases.length} test cases loaded` : 'No test cases loaded'}
          </span>
          <button className="nav-item" onClick={loadFromSupabase} style={{ opacity: 0.7, fontSize: '12px' }}>
            <RefreshCw size={13} /> Refresh
          </button>
          <div className="brand-credit">
            <span>Exclusive Datman QA Tool</span>
            <span>Crafted by Sundar</span>
          </div>
        </div>
      </aside>

      <main className="main">
        {activeView === 'settings' && (
          <SettingsView
            config={githubConfig}
            onSave={(cfg) => { setGithubConfig(cfg); saveGithubConfig(cfg); saveConfigToSupabase(cfg); fetchFromGithub(cfg) }}
            onLoadFiles={loadLocalFiles}
            loading={loadingCsv}
            progress={loadProgress}
            error={csvError}
            testCasesCount={testCases.length}
            csvSources={csvSources}
          />
        )}
        {activeView === 'releases' && (
          <ReleasesView
            releases={releases}
            onNew={() => setShowNewRelease(true)}
            onOpen={(id) => { setActiveReleaseId(id); setActiveView('release-detail') }}
            onDelete={deleteRelease}
            onClone={cloneRelease}
            getStats={getStats}
            showNew={showNewRelease}
            newRelease={newRelease}
            setNewRelease={setNewRelease}
            onAddRelease={addRelease}
            onCancelNew={() => setShowNewRelease(false)}
          />
        )}
        {activeView === 'coverage' && (
          <CoverageView testCases={testCases} />
        )}
        {activeView === 'release-detail' && activeRelease && (
          <ReleaseDetailView
            release={activeRelease}
            allTestCases={filteredTestCases}
            searchQ={searchQ}
            setSearchQ={setSearchQ}
            onToggle={(tc) => toggleTestCase(activeRelease.id, tc)}
            onBulkToggle={(tcs, add) => bulkToggle(activeRelease.id, tcs, add)}
            onStatusChange={(tcId, status) => updateTestStatus(activeRelease.id, tcId, status)}
            onNotesChange={(tcId, notes) => updateTestNotes(activeRelease.id, tcId, notes)}
            onBack={() => setActiveView('releases')}
            onExport={() => exportRelease(activeRelease)}
            getStats={getStats}
            loadingCsv={loadingCsv}
            onRefresh={fetchFromGithub}
            testCasesLoaded={testCases.length > 0}
            onChecklistChange={(key, val) => updateChecklist(activeRelease.id, key, val)}
          />
        )}
      </main>
    </div>
  )
}

// ── Coverage helpers ───────────────────────────────────────────────────────────
function DonutChart({ segments, size = 148 }) {
  const thickness = 20
  const r = (size - thickness) / 2
  const circ = 2 * Math.PI * r
  const cx = size / 2, cy = size / 2
  const total = segments.reduce((s, sg) => s + sg.value, 0)
  if (!total) return null

  let cumPct = 0
  return (
    <svg width={size} height={size} style={{ display: 'block' }}>
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--bg3)" strokeWidth={thickness} />
      {segments.filter(s => s.value > 0).map((seg, i) => {
        const pct = seg.value / total
        const dashLen = Math.max(0, pct * circ - 2)
        const rotation = -90 + cumPct * 360
        cumPct += pct
        return (
          <circle key={i} cx={cx} cy={cy} r={r} fill="none"
            stroke={seg.color} strokeWidth={thickness}
            strokeDasharray={`${dashLen} ${circ}`}
            transform={`rotate(${rotation}, ${cx}, ${cy})`}
          />
        )
      })}
      <text x={cx} y={cy - 7} textAnchor="middle"
        fill="var(--text)" fontSize="22" fontFamily="var(--font-head)" fontWeight="700">
        {total}
      </text>
      <text x={cx} y={cy + 11} textAnchor="middle"
        fill="var(--text3)" fontSize="9" fontFamily="var(--font-body)">
        test cases
      </text>
    </svg>
  )
}

function CovStatCard({ label, value, color, pct }) {
  return (
    <div className="cov-stat-card">
      <div className="cov-stat-value" style={{ color }}>{value}</div>
      <div className="cov-stat-label">{label}</div>
      {pct !== undefined && (
        <div className="cov-stat-pct" style={{ color }}>{pct}%</div>
      )}
    </div>
  )
}

// ── Coverage View ──────────────────────────────────────────────────────────────
function CoverageView({ testCases }) {
  const total = testCases.length

  const byFolder = testCases.reduce((acc, tc) => {
    const folder = tc.source ? tc.source.split('/')[0] : '(local)'
    if (!acc[folder]) acc[folder] = { total: 0, p0: 0, p1: 0, p2: 0 }
    acc[folder].total++
    const p = (tc.priority || '').toUpperCase()
    if (p === 'P0') acc[folder].p0++
    else if (p === 'P1') acc[folder].p1++
    else if (p === 'P2') acc[folder].p2++
    return acc
  }, {})

  const byModule = testCases.reduce((acc, tc) => {
    const mod = tc.module || 'Unknown'
    if (!acc[mod]) acc[mod] = { total: 0, p0: 0, p1: 0, p2: 0, submodules: new Set() }
    acc[mod].total++
    const p = (tc.priority || '').toUpperCase()
    if (p === 'P0') acc[mod].p0++
    else if (p === 'P1') acc[mod].p1++
    else if (p === 'P2') acc[mod].p2++
    if (tc.submodule) acc[mod].submodules.add(tc.submodule)
    return acc
  }, {})

  const p0    = testCases.filter(tc => (tc.priority || '').toUpperCase() === 'P0').length
  const p1    = testCases.filter(tc => (tc.priority || '').toUpperCase() === 'P1').length
  const p2    = testCases.filter(tc => (tc.priority || '').toUpperCase() === 'P2').length
  const other = total - p0 - p1 - p2

  const folderEntries = Object.entries(byFolder).sort((a, b) => b[1].total - a[1].total)
  const moduleEntries = Object.entries(byModule).sort((a, b) => b[1].total - a[1].total)
  const maxFolder     = Math.max(...folderEntries.map(([, d]) => d.total), 1)
  const maxModule     = Math.max(...moduleEntries.map(([, d]) => d.total), 1)

  const prioritySegments = [
    { label: 'P0 Critical', value: p0,    color: '#f04e6a' },
    { label: 'P1 High',     value: p1,    color: '#f0b429' },
    { label: 'P2 Medium',   value: p2,    color: '#3b9eff' },
    { label: 'Untagged',    value: other, color: 'var(--border2)' },
  ]

  if (!total) {
    return (
      <div className="view">
        <div className="view-header">
          <div><h1>Coverage</h1><p className="subtitle">Manual test case insights</p></div>
        </div>
        <div className="empty-state">
          <BarChart2 size={32} strokeWidth={1} />
          <p>No test cases loaded</p>
          <span>Go to Settings to sync your CSV files</span>
        </div>
      </div>
    )
  }

  return (
    <div className="view cov-view">
      <div className="view-header">
        <div>
          <h1>Coverage</h1>
          <p className="subtitle">
            {total} "Can't be automated" test cases across {folderEntries.length} source folder{folderEntries.length !== 1 ? 's' : ''}
          </p>
        </div>
      </div>

      {/* ── Stat cards ── */}
      <div className="cov-stat-row">
        <CovStatCard label="Total"      value={total} color="var(--accent2)" />
        <CovStatCard label="P0 Critical" value={p0}   color="#f04e6a"
          pct={total ? Math.round(p0 / total * 100) : 0} />
        <CovStatCard label="P1 High"    value={p1}    color="#f0b429"
          pct={total ? Math.round(p1 / total * 100) : 0} />
        <CovStatCard label="P2 Medium"  value={p2}    color="#3b9eff"
          pct={total ? Math.round(p2 / total * 100) : 0} />
        <CovStatCard label="Untagged"   value={other}  color="var(--text3)"
          pct={total ? Math.round(other / total * 100) : 0} />
      </div>

      {/* ── Charts row ── */}
      <div className="cov-charts-row">

        {/* Folder bar chart */}
        <div className="cov-card" style={{ flex: 2 }}>
          <div className="cov-card-title">By Source Folder</div>
          <div className="cov-bar-list">
            {folderEntries.map(([folder, data], i) => {
              const pct = Math.round((data.total / total) * 100)
              const barW = Math.round((data.total / maxFolder) * 100)
              const col  = CHART_COLORS[i % CHART_COLORS.length]
              return (
                <div key={folder} className="cov-bar-row">
                  <div className="cov-bar-label" title={folder}>{folder}</div>
                  <div className="cov-bar-track">
                    <div className="cov-bar-fill" style={{ width: `${barW}%`, background: col }} />
                  </div>
                  <div className="cov-bar-meta">
                    <span className="cov-bar-count">{data.total}</span>
                    <span className="cov-bar-pct">{pct}%</span>
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* Priority donut */}
        <div className="cov-card cov-donut-card">
          <div className="cov-card-title">By Priority</div>
          <DonutChart segments={prioritySegments} />
          <div className="cov-legend">
            {prioritySegments.filter(s => s.value > 0).map(seg => (
              <div key={seg.label} className="cov-legend-row">
                <span className="cov-legend-dot" style={{ background: seg.color }} />
                <span className="cov-legend-label">{seg.label}</span>
                <span className="cov-legend-val">{seg.value}</span>
                <span className="cov-legend-pct">{Math.round(seg.value / total * 100)}%</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Module breakdown ── */}
      <div className="cov-card">
        <div className="cov-card-title">Module Breakdown</div>
        <div className="cov-mod-table">
          <div className="cov-mod-head">
            <span>Module</span>
            <span className="cov-col-center">Submodules</span>
            <span className="cov-col-right">Count</span>
            <span>Distribution</span>
            <span>Priorities</span>
          </div>
          {moduleEntries.map(([mod, data], i) => {
            const barW   = Math.round((data.total / maxModule) * 100)
            const col    = CHART_COLORS[i % CHART_COLORS.length]
            const tagged = data.p0 + data.p1 + data.p2
            const unk    = data.total - tagged
            return (
              <div key={mod} className="cov-mod-row">
                <span className="cov-mod-name" title={mod}>{mod}</span>
                <span className="cov-col-center cov-mod-subs">{data.submodules.size}</span>
                <span className="cov-col-right cov-mod-count">{data.total}</span>
                <div className="cov-mod-bar-track">
                  <div className="cov-mod-bar-fill" style={{ width: `${barW}%`, background: col + 'cc' }} />
                </div>
                <div className="cov-mod-pills">
                  {data.p0 > 0 && <span className="cov-pill p0">P0&thinsp;{data.p0}</span>}
                  {data.p1 > 0 && <span className="cov-pill p1">P1&thinsp;{data.p1}</span>}
                  {data.p2 > 0 && <span className="cov-pill p2">P2&thinsp;{data.p2}</span>}
                  {unk  > 0 && <span className="cov-pill other">?&thinsp;{unk}</span>}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* ── Submodule detail: top-heavy modules ── */}
      {moduleEntries.filter(([, d]) => d.submodules.size > 0).slice(0, 5).map(([mod, data], mi) => {
        const subCounts = testCases
          .filter(tc => tc.module === mod && tc.submodule)
          .reduce((acc, tc) => {
            acc[tc.submodule] = (acc[tc.submodule] || 0) + 1
            return acc
          }, {})
        const subEntries = Object.entries(subCounts).sort((a, b) => b[1] - a[1])
        const maxSub     = Math.max(...subEntries.map(([, v]) => v), 1)
        const col        = CHART_COLORS[mi % CHART_COLORS.length]

        return (
          <div key={mod} className="cov-card">
            <div className="cov-card-title">
              <span style={{ color: col }}>{mod}</span>
              <span style={{ color: 'var(--text3)', fontWeight: 400, marginLeft: '8px' }}>
                — {data.total} test cases across {subEntries.length} submodules
              </span>
            </div>
            <div className="cov-bar-list cov-sub-bars">
              {subEntries.map(([sub, cnt]) => (
                <div key={sub} className="cov-bar-row">
                  <div className="cov-bar-label sm" title={sub}>{sub}</div>
                  <div className="cov-bar-track">
                    <div className="cov-bar-fill" style={{ width: `${Math.round((cnt / maxSub) * 100)}%`, background: col + '99' }} />
                  </div>
                  <div className="cov-bar-meta">
                    <span className="cov-bar-count">{cnt}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Settings View ──────────────────────────────────────────────────────────────
function SettingsView({ config, onSave, onLoadFiles, loading, progress, error, testCasesCount, csvSources }) {
  const [form, setForm]   = useState({ ...DEFAULT_GITHUB_CONFIG, ...config })
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef(null)
  const set = (k, v) => setForm(p => ({ ...p, [k]: v }))

  const handleFiles = (files) => {
    const csvFiles = Array.from(files).filter(f => f.name.toLowerCase().endsWith('.csv'))
    if (csvFiles.length) onLoadFiles(csvFiles)
  }

  const sourcesByFolder = csvSources.reduce((acc, s) => {
    const parts = s.name.split('/')
    const folder = parts.length > 1 ? parts[0] : '(root)'
    if (!acc[folder]) acc[folder] = { count: 0, total: 0, files: [] }
    acc[folder].count += s.count
    acc[folder].total += s.total
    acc[folder].files.push(s)
    return acc
  }, {})

  return (
    <div className="view">
      <div className="view-header">
        <div>
          <h1>Settings</h1>
          <p className="subtitle">Only "Can't be automated" rows are loaded — everything else is ignored</p>
        </div>
      </div>

      {/* ── GitHub multi-folder ── */}
      <div className="settings-card" style={{ marginBottom: '1rem' }}>
        <h3 className="card-title">
          <FileText size={14} /> GitHub Repository
        </h3>

        <div className="field-row">
          <div className="field-group" style={{ gridColumn: 'span 2' }}>
            <label>Repo URL</label>
            <input value={form.url} onChange={e => set('url', e.target.value)}
              placeholder="https://github.com/sundaresan-omnipay/Gateway-testcases-csv-main" />
          </div>
        </div>

        <div className="field-row">
          <div className="field-group">
            <label>Branch</label>
            <input value={form.branch} onChange={e => set('branch', e.target.value)} placeholder="main" />
          </div>
          <div className="field-group">
            <label>Personal Access Token <span style={{ color: 'var(--text3)', fontWeight: 400 }}>(required for private repos)</span></label>
            <input type="password" value={form.token || ''} onChange={e => set('token', e.target.value)}
              placeholder="ghp_xxxxxxxxxxxx" />
          </div>
        </div>

        {/* Mode toggle */}
        <div className="mode-toggle">
          <button className={`mode-btn ${form.mode !== 'file' ? 'active' : ''}`} onClick={() => set('mode', 'folders')}>
            Folders (auto-scan all CSV files)
          </button>
          <button className={`mode-btn ${form.mode === 'file' ? 'active' : ''}`} onClick={() => set('mode', 'file')}>
            Single file
          </button>
        </div>

        {form.mode !== 'file' ? (
          <div className="field-group">
            <label>Folder paths — one per line</label>
            <textarea
              value={form.folders || ''}
              onChange={e => set('folders', e.target.value)}
              rows={5}
              style={{ resize: 'vertical', fontFamily: 'var(--font-mono)', fontSize: '12px' }}
              placeholder={'adyen_direct_intergration\nCardstream\nCheckout\nInternal Fund Transfer'}
            />
            <span className="field-hint">
              Each folder is scanned for .csv files automatically — no need to list individual files.
            </span>
          </div>
        ) : (
          <div className="field-group">
            <label>CSV File Path</label>
            <input value={form.file || ''} onChange={e => set('file', e.target.value)}
              placeholder="reports/cant_be_automated_master.csv" />
          </div>
        )}

        {loading && progress && (
          <div className="info-box" style={{ marginBottom: '0.75rem' }}>
            <RefreshCw size={13} className="spin" /> {progress}
          </div>
        )}
        {loading && !progress && (
          <div className="info-box" style={{ marginBottom: '0.75rem' }}>
            <RefreshCw size={13} className="spin" /> Connecting to GitHub…
          </div>
        )}
        {error && (
          <div className="error-box" style={{ marginBottom: '0.75rem', whiteSpace: 'pre-wrap' }}>
            <XCircle size={13} style={{ flexShrink: 0 }} /> {error}
          </div>
        )}
        {testCasesCount > 0 && !loading && (
          <div className="success-box" style={{ marginBottom: '0.75rem' }}>
            <CheckCircle size={13} /> {testCasesCount} "Can't be automated" test cases synced
          </div>
        )}

        <button className="btn-primary" onClick={() => onSave(form)} disabled={loading}>
          {loading
            ? <><RefreshCw size={13} className="spin" /> Loading…</>
            : <><RefreshCw size={13} /> Sync from GitHub</>}
        </button>

        {Object.keys(sourcesByFolder).length > 0 && (
          <div className="source-list" style={{ marginTop: '1rem' }}>
            {Object.entries(sourcesByFolder).map(([folder, data]) => (
              <details key={folder} className="folder-row">
                <summary className="source-item folder-summary">
                  <FileText size={12} />
                  <span className="source-name">{folder}</span>
                  <span className="source-count">{data.count} manual / {data.total} total</span>
                </summary>
                {data.files.map(f => {
                  const fileName = f.name.split('/').pop()
                  return (
                    <div key={f.name} className="source-item file-row">
                      <span style={{ width: 12 }} />
                      <span className="source-name" style={{ color: 'var(--text3)', fontSize: '11px' }}>{fileName}</span>
                      <span className="source-count">{f.count} / {f.total}</span>
                    </div>
                  )
                })}
              </details>
            ))}
          </div>
        )}
      </div>

      {/* ── Local file upload ── */}
      <div className="settings-card" style={{ marginBottom: '1rem' }}>
        <h3 className="card-title"><Upload size={14} /> Upload Local CSV Files</h3>
        <div
          className={`drop-zone ${dragOver ? 'drag-over' : ''}`}
          onDragOver={e => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={e => { e.preventDefault(); setDragOver(false); handleFiles(e.dataTransfer.files) }}
          onClick={() => fileInputRef.current?.click()}
        >
          <Upload size={28} strokeWidth={1.5} color="var(--text3)" />
          <p>Drop CSV files here or click to browse</p>
          <span>Pick individual files from any folder — all are merged and filtered</span>
          <input ref={fileInputRef} type="file" accept=".csv" multiple style={{ display: 'none' }}
            onChange={e => handleFiles(e.target.files)} />
        </div>
      </div>

      <div className="settings-card">
        <h3 className="card-title">Expected CSV Columns</h3>
        <div className="code-block">
          Module, Submodule, Parent ID, <strong>Test Case #</strong>, <strong>Scenario</strong>,<br />
          Precondition, Test Data, Test steps, Expected Result,<br />
          Labels, Priority, <strong>Automation Status</strong>
        </div>
        <p style={{ fontSize: '11px', color: 'var(--text3)', marginTop: '0.5rem' }}>
          Rows where <code>Automation Status</code> ≠ "Cant be automated" are silently ignored.
        </p>
      </div>
    </div>
  )
}

// ── Releases View ──────────────────────────────────────────────────────────────
const DEFAULT_CHECKLIST = [
  { key: 'smoke',       label: 'Smoke test completed' },
  { key: 'regression',  label: 'Full regression run' },
  { key: 'p0_resolved', label: 'P0/P1 failures resolved or accepted' },
  { key: 'browser',     label: 'Browser compatibility verified' },
  { key: 'api',         label: 'API contract tests passed' },
  { key: 'qa_signoff',  label: 'QA sign-off obtained' },
  { key: 'approved',    label: 'Reviewer approved' },
]

const ENV_CONFIG = {
  Staging:    { color: '#818CF8', bg: 'rgba(129,140,248,0.12)', border: 'rgba(129,140,248,0.4)' },
  UAT:        { color: '#FCD34D', bg: 'rgba(251,191,36,0.12)',  border: 'rgba(251,191,36,0.4)' },
  Production: { color: '#34D399', bg: 'rgba(16,185,129,0.12)', border: 'rgba(16,185,129,0.4)' },
  Hotfix:     { color: '#FCA5A5', bg: 'rgba(248,113,113,0.12)',border: 'rgba(248,113,113,0.4)' },
  Sandbox:    { color: '#C4B5FD', bg: 'rgba(139,92,246,0.12)', border: 'rgba(139,92,246,0.4)' },
}

function getShipStatus(release, s) {
  if (s.total === 0) return null
  const p0Fails = release.testCases.filter(t => t.priority === 'P0' && t.status === 'fail').length
  if (p0Fails > 0) return { label: 'Blocked', color: '#FCA5A5', bg: 'rgba(248,113,113,0.12)', border: 'rgba(248,113,113,0.45)' }
  if (s.fail > 0 && s.pending === 0) return { label: 'Has Failures', color: '#FCD34D', bg: 'rgba(251,191,36,0.1)', border: 'rgba(251,191,36,0.4)' }
  if (s.pending > 0) return { label: 'In Progress', color: '#A78BFA', bg: 'rgba(139,92,246,0.1)', border: 'rgba(139,92,246,0.35)' }
  return { label: 'Ready to Ship', color: '#34D399', bg: 'rgba(16,185,129,0.12)', border: 'rgba(16,185,129,0.45)' }
}

function ReleasesView({ releases, onNew, onOpen, onDelete, onClone, getStats, showNew, newRelease, setNewRelease, onAddRelease, onCancelNew }) {
  const set = (k, v) => setNewRelease(p => ({ ...p, [k]: v }))
  const [collapsedMonths, setCollapsedMonths] = useState({})
  const [envFilter, setEnvFilter] = useState('all')

  const filtered = envFilter === 'all' ? releases : releases.filter(r => (r.environment || 'Staging') === envFilter)

  // Group by month using releaseDate if set, otherwise createdAt
  const monthGroups = {}
  filtered.forEach(r => {
    const d = r.releaseDate ? new Date(r.releaseDate + 'T00:00:00') : new Date(r.createdAt)
    const key = d.toLocaleString('default', { month: 'long', year: 'numeric' })
    if (!monthGroups[key]) monthGroups[key] = []
    monthGroups[key].push(r)
  })

  const toggleMonth = (m) => setCollapsedMonths(p => ({ ...p, [m]: !p[m] }))
  const usedEnvs = [...new Set(releases.map(r => r.environment || 'Staging'))]

  return (
    <div className="view">
      <div className="view-header">
        <div>
          <h1>Releases</h1>
          <p className="subtitle">{releases.length} release{releases.length !== 1 ? 's' : ''} tracked</p>
        </div>
        <button className="btn-primary" onClick={onNew}><Plus size={14} /> New Release</button>
      </div>

      {/* Env filter chips */}
      {usedEnvs.length > 1 && (
        <div className="filter-chips" style={{ marginBottom: '1rem' }}>
          <button className={`filter-chip ${envFilter === 'all' ? 'active' : ''}`} onClick={() => setEnvFilter('all')}>
            All Environments
          </button>
          {usedEnvs.map(env => {
            const cfg = ENV_CONFIG[env] || ENV_CONFIG.Staging
            return (
              <button key={env}
                className={`filter-chip ${envFilter === env ? 'active' : ''}`}
                style={envFilter === env ? { color: cfg.color, background: cfg.bg, borderColor: cfg.border } : {}}
                onClick={() => setEnvFilter(p => p === env ? 'all' : env)}>
                {env}
              </button>
            )
          })}
        </div>
      )}

      {showNew && (
        <div className="new-release-card">
          <div className="new-release-header">
            <span>New Release</span>
            <button className="icon-btn" onClick={onCancelNew}><X size={15} /></button>
          </div>
          <div className="field-row">
            <div className="field-group">
              <label>Release Name *</label>
              <input value={newRelease.name} onChange={e => set('name', e.target.value)} placeholder="v2.4.1 — Payments Revamp" />
            </div>
            <div className="field-group">
              <label>Jira Ticket</label>
              <input value={newRelease.jiraTicket} onChange={e => set('jiraTicket', e.target.value)} placeholder="REL-123" />
            </div>
          </div>
          <div className="field-row">
            <div className="field-group">
              <label>Release Date</label>
              <input type="date" value={newRelease.releaseDate} onChange={e => set('releaseDate', e.target.value)} />
            </div>
            <div className="field-group">
              <label>Environment</label>
              <select value={newRelease.environment} onChange={e => set('environment', e.target.value)}>
                {Object.keys(ENV_CONFIG).map(k => <option key={k} value={k}>{k}</option>)}
              </select>
            </div>
          </div>
          <div className="field-group">
            <label>Jira URL</label>
            <input value={newRelease.jiraUrl} onChange={e => set('jiraUrl', e.target.value)}
              placeholder="https://your-org.atlassian.net/browse/REL-123" />
          </div>
          <div className="field-row">
            <div className="field-group">
              <label>QA Resource</label>
              <input value={newRelease.qaResource} onChange={e => set('qaResource', e.target.value)} placeholder="e.g. Rohit" />
            </div>
            <div className="field-group">
              <label>Reviewer</label>
              <input value={newRelease.reviewer} onChange={e => set('reviewer', e.target.value)} placeholder="e.g. Nitish" />
            </div>
          </div>
          <div className="field-group">
            <label>Description</label>
            <textarea value={newRelease.description} onChange={e => set('description', e.target.value)}
              placeholder="What's being tested in this release…" rows={2} style={{ resize: 'vertical' }} />
          </div>
          <button className="btn-primary" onClick={onAddRelease} disabled={!newRelease.name.trim()}>
            Create Release
          </button>
        </div>
      )}

      {releases.length === 0 && !showNew && (
        <div className="empty-state">
          <Layers size={32} strokeWidth={1} />
          <p>No releases yet</p>
          <span>Create a release to start tracking manual test cases</span>
        </div>
      )}

      {Object.entries(monthGroups).map(([month, monthReleases]) => {
        const collapsed = collapsedMonths[month]
        const monthPass = monthReleases.reduce((sum, r) => sum + getStats(r).pass, 0)
        const monthTotal = monthReleases.reduce((sum, r) => sum + getStats(r).total, 0)
        return (
          <div key={month} className="month-group">
            <button className="month-header" onClick={() => toggleMonth(month)}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                <span className="month-label">{month}</span>
                <span className="month-count">{monthReleases.length} release{monthReleases.length !== 1 ? 's' : ''}</span>
              </div>
              {monthTotal > 0 && (
                <span className="month-progress">
                  {monthPass}/{monthTotal} passed
                </span>
              )}
            </button>

            {!collapsed && (
              <div className="releases-grid" style={{ padding: '0 0 8px' }}>
                {monthReleases.map(r => {
                  const s = getStats(r)
                  const pct = s.total > 0 ? Math.round((s.pass / s.total) * 100) : 0
                  const ship = getShipStatus(r, s)
                  const env = r.environment || 'Staging'
                  const envCfg = ENV_CONFIG[env] || ENV_CONFIG.Staging
                  return (
                    <div className="release-card" key={r.id} onClick={() => onOpen(r.id)}>
                      <div className="release-card-top">
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', marginBottom: '3px' }}>
                            <div className="release-name">{r.name}</div>
                            <span className="env-badge" style={{ color: envCfg.color, background: envCfg.bg, border: `1px solid ${envCfg.border}` }}>{env}</span>
                            {ship && (
                              <span className="ship-badge" style={{ color: ship.color, background: ship.bg, border: `1px solid ${ship.border}` }}>
                                {ship.label}
                              </span>
                            )}
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                            {r.jiraTicket && (
                              <a className="jira-badge" href={r.jiraUrl || '#'} target="_blank" rel="noreferrer"
                                onClick={e => e.stopPropagation()}>
                                <ExternalLink size={11} /> {r.jiraTicket}
                              </a>
                            )}
                            {r.releaseDate && (
                              <span style={{ fontSize: '11px', color: 'var(--text3)', display: 'flex', alignItems: 'center', gap: '3px' }}>
                                📅 {new Date(r.releaseDate + 'T00:00:00').toLocaleDateString('default', { day: 'numeric', month: 'short' })}
                              </span>
                            )}
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                          <button className="icon-btn" title="Clone release" onClick={e => { e.stopPropagation(); onClone(r) }}>
                            <Copy size={14} />
                          </button>
                          <button className="icon-btn danger" onClick={e => { e.stopPropagation(); onDelete(r.id) }}>
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </div>
                      {r.description && <p className="release-desc">{r.description}</p>}
                      {(r.qaResource || r.reviewer) && (
                        <div className="release-people">
                          {r.qaResource && <span className="person-badge qa"><User size={10} /> QA: {r.qaResource}</span>}
                          {r.reviewer && <span className="person-badge rev"><UserCheck size={10} /> Reviewer: {r.reviewer}</span>}
                        </div>
                      )}
                      <div className="release-stats">
                        {Object.entries({ pass: s.pass, fail: s.fail, skip: s.skip, pending: s.pending }).map(([k, v]) => (
                          <span key={k} className={`stat-badge stat-${k}`}>{v} {k}</span>
                        ))}
                      </div>
                      <div className="progress-bar">
                        <div className="progress-fill" style={{ width: `${pct}%` }} />
                      </div>
                      <div className="progress-label">{s.total} test cases · {pct}% passed</div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Release Detail View ────────────────────────────────────────────────────────
function ReleaseDetailView({ release, allTestCases, searchQ, setSearchQ, onToggle, onBulkToggle, onStatusChange, onNotesChange, onBack, onExport, getStats, loadingCsv, onRefresh, testCasesLoaded, onChecklistChange }) {
  const [tab, setTab] = useState('run')
  const [copied, setCopied] = useState(false)
  const s = getStats(release)
  const ship = getShipStatus(release, s)
  const env = release.environment || 'Staging'
  const envCfg = ENV_CONFIG[env] || ENV_CONFIG.Staging
  const checklistDone = DEFAULT_CHECKLIST.filter(item => release.checklist?.[item.key]).length

  function copySummary() {
    const pct = s.total > 0 ? Math.round((s.pass / s.total) * 100) : 0
    const failedTcs = release.testCases.filter(t => t.status === 'fail')
    const lines = [
      `🚦 Release: ${release.name}`,
      release.jiraTicket ? `🎫 Jira: ${release.jiraTicket}` : '',
      release.qaResource ? `👤 QA: ${release.qaResource}` : '',
      ``,
      `✅ Pass: ${s.pass}   ❌ Fail: ${s.fail}   ⚠️ Skip: ${s.skip}   ⏳ Pending: ${s.pending}`,
      `📊 Progress: ${pct}% of ${s.total} tests complete`,
    ]
    if (failedTcs.length > 0) {
      lines.push(``, `❌ Failed Tests:`)
      failedTcs.slice(0, 10).forEach(tc => {
        lines.push(`  • ${tc.id} – ${tc.title}${tc.notes ? ` (${tc.notes.slice(0, 60)}${tc.notes.length > 60 ? '…' : ''})` : ''}`)
      })
      if (failedTcs.length > 10) lines.push(`  … and ${failedTcs.length - 10} more`)
    }
    lines.push(``, `Generated by Beacon · Datman QA`)
    navigator.clipboard.writeText(lines.filter(l => l !== null).join('\n'))
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="view">
      <div className="view-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <button className="icon-btn" onClick={onBack}>
            <ChevronDown size={16} style={{ transform: 'rotate(90deg)' }} />
          </button>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <h1>{release.name}</h1>
              <span className="env-badge env-badge-lg" style={{ color: envCfg.color, background: envCfg.bg, border: `1px solid ${envCfg.border}` }}>{env}</span>
              {ship && (
                <span className="ship-badge ship-badge-lg" style={{ color: ship.color, background: ship.bg, border: `1px solid ${ship.border}` }}>
                  {ship.label}
                </span>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '4px', flexWrap: 'wrap' }}>
              {release.jiraTicket && (
                <a className="jira-badge" href={release.jiraUrl || '#'} target="_blank" rel="noreferrer">
                  <ExternalLink size={11} /> {release.jiraTicket}
                </a>
              )}
              {release.qaResource && (
                <span className="person-badge qa">
                  <User size={10} /> QA: {release.qaResource}
                </span>
              )}
              {release.reviewer && (
                <span className="person-badge rev">
                  <UserCheck size={10} /> Reviewer: {release.reviewer}
                </span>
              )}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button className={`btn-copy ${copied ? 'copied' : ''}`} onClick={copySummary}>
            {copied ? <CheckCircle size={13} /> : <Download size={13} />}
            {copied ? 'Copied!' : 'Copy Summary'}
          </button>
          <button className="btn-ghost" onClick={onExport}><Download size={13} /> Export CSV</button>
        </div>
      </div>

      {/* Stats bar */}
      <div className="stats-bar">
        {Object.entries(STATUS_CONFIG).map(([k, cfg]) => {
          const Icon = cfg.icon
          return (
            <div className="stat-item" key={k}>
              <Icon size={14} color={cfg.color} />
              <span style={{ color: cfg.color }}>{s[k]}</span>
              <span className="stat-lbl">{cfg.label}</span>
            </div>
          )
        })}
        <div className="stat-item">
          <Layers size={14} color="var(--accent2)" />
          <span style={{ color: 'var(--accent2)' }}>{s.total}</span>
          <span className="stat-lbl">Total</span>
        </div>
        <div style={{ marginLeft: 'auto' }}>
          {s.total > 0 && (
            <div className="mini-progress">
              <div className="mini-progress-fill" style={{ width: `${s.total > 0 ? Math.round((s.pass / s.total) * 100) : 0}%` }} />
            </div>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="tabs">
        <button className={`tab ${tab === 'run' ? 'active' : ''}`} onClick={() => setTab('run')}>
          Run Tests ({s.total})
        </button>
        <button className={`tab ${tab === 'pick' ? 'active' : ''}`} onClick={() => setTab('pick')}>
          Pick Test Cases {allTestCases.length > 0 && `(${allTestCases.length} available)`}
        </button>
        <button className={`tab ${tab === 'checklist' ? 'active' : ''}`} onClick={() => setTab('checklist')}>
          Checklist {checklistDone > 0 && `(${checklistDone}/${DEFAULT_CHECKLIST.length})`}
        </button>
      </div>

      {/* Search */}
      <div className="search-bar">
        <Search size={14} />
        <input value={searchQ} onChange={e => setSearchQ(e.target.value)}
          placeholder="Search by ID, scenario, module, label, priority…"
          style={{ border: 'none', background: 'transparent', padding: '0' }} />
        {searchQ && (
          <button className="icon-btn" style={{ padding: '2px' }} onClick={() => setSearchQ('')}>
            <X size={13} />
          </button>
        )}
      </div>

      {tab === 'pick' && (
        <PickPanel
          allTestCases={allTestCases}
          release={release}
          onToggle={onToggle}
          onBulkToggle={onBulkToggle}
          testCasesLoaded={testCasesLoaded}
          loadingCsv={loadingCsv}
          onRefresh={onRefresh}
        />
      )}

      {tab === 'run' && (
        <RunPanel
          release={release}
          onStatusChange={onStatusChange}
          onNotesChange={onNotesChange}
        />
      )}

      {tab === 'checklist' && (
        <ChecklistPanel checklist={release.checklist || {}} onChange={onChecklistChange} done={checklistDone} total={DEFAULT_CHECKLIST.length} />
      )}
    </div>
  )
}

// ── Pick Panel ─────────────────────────────────────────────────────────────────
function PickPanel({ allTestCases, release, onToggle, onBulkToggle, testCasesLoaded, loadingCsv, onRefresh }) {
  const [collapsedModules, setCollapsedModules]       = useState({})
  const [collapsedSubmodules, setCollapsedSubmodules] = useState({})

  const selectedIds = new Set(release.testCases.map(t => t.id))

  const hierarchy = allTestCases.reduce((acc, tc) => {
    const mod = tc.module || 'Uncategorised'
    const sub = tc.submodule || 'General'
    if (!acc[mod]) acc[mod] = {}
    if (!acc[mod][sub]) acc[mod][sub] = []
    acc[mod][sub].push(tc)
    return acc
  }, {})

  const toggleMod = (mod) => setCollapsedModules(p => ({ ...p, [mod]: !p[mod] }))
  const toggleSub = (key) => setCollapsedSubmodules(p => ({ ...p, [key]: !p[key] }))

  if (!testCasesLoaded) {
    return (
      <div className="pick-panel">
        <div className="warn-box">
          <AlertCircle size={13} />
          No test cases loaded. Go to <strong>Settings</strong> to upload your CSV files.
          <button className="btn-ghost sm" onClick={onRefresh} disabled={loadingCsv} style={{ marginLeft: '8px' }}>
            {loadingCsv ? <RefreshCw size={12} className="spin" /> : <RefreshCw size={12} />} Refresh
          </button>
        </div>
      </div>
    )
  }

  if (allTestCases.length === 0) {
    return (
      <div className="pick-panel">
        <div className="empty-state sm">
          <Search size={24} strokeWidth={1} />
          <p>No matches</p>
          <span>Try a different search term</span>
        </div>
      </div>
    )
  }

  return (
    <div className="pick-panel">
      {Object.entries(hierarchy).map(([mod, submodules]) => {
        const allModTcs   = Object.values(submodules).flat()
        const selectedCnt = allModTcs.filter(tc => selectedIds.has(tc.id)).length
        const allSelected = selectedCnt === allModTcs.length
        const isCollapsed = collapsedModules[mod]

        return (
          <div key={mod} className="module-group">
            <div className="module-header">
              <div className="module-header-left" onClick={() => toggleMod(mod)}>
                {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                <span className="module-name">{mod}</span>
                <span className="count-badge">{allModTcs.length}</span>
                {selectedCnt > 0 && !allSelected && (
                  <span className="partial-badge">{selectedCnt} selected</span>
                )}
                {allSelected && <span className="all-badge">all selected</span>}
              </div>
              <button className="select-all-btn" onClick={() => onBulkToggle(allModTcs, !allSelected)}>
                {allSelected ? 'Deselect all' : 'Select all'}
              </button>
            </div>

            {!isCollapsed && Object.entries(submodules).map(([sub, tcs]) => {
              const subKey      = `${mod}__${sub}`
              const subSelCnt   = tcs.filter(tc => selectedIds.has(tc.id)).length
              const allSubSel   = subSelCnt === tcs.length
              const subCollapsed = collapsedSubmodules[subKey]

              return (
                <div key={subKey} className="submodule-group">
                  <div className="submodule-header">
                    <div className="submodule-header-left" onClick={() => toggleSub(subKey)}>
                      {subCollapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
                      <span>{sub}</span>
                      <span className="count-badge sm">{tcs.length}</span>
                    </div>
                    <button className="select-all-btn sm" onClick={() => onBulkToggle(tcs, !allSubSel)}>
                      {allSubSel ? 'Deselect' : 'Select all'}
                    </button>
                  </div>

                  {!subCollapsed && tcs.map(tc => {
                    const selected = selectedIds.has(tc.id)
                    return (
                      <label key={tc.id} className={`pick-item ${selected ? 'selected' : ''}`}>
                        <input type="checkbox" checked={selected} onChange={() => onToggle(tc)} />
                        <div className="pick-item-content">
                          <div className="pick-item-top">
                            <PriorityBadge priority={tc.priority} />
                            <span className="tc-id">{tc.id}</span>
                          </div>
                          <span className="tc-title">{tc.title}</span>
                          {tc.labels && <LabelChips labels={tc.labels} max={4} />}
                        </div>
                      </label>
                    )
                  })}
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}

// ── Checklist Panel ───────────────────────────────────────────────────────────
function ChecklistPanel({ checklist, onChange, done, total }) {
  const allDone = done === total
  return (
    <div className="checklist-panel">
      <div className="checklist-header">
        <div>
          <span className="checklist-title">Pre-Release Gates</span>
          <span className="checklist-sub">Sign off each gate before marking the release ready</span>
        </div>
        <div className="checklist-progress-wrap">
          <span className="checklist-count" style={{ color: allDone ? 'var(--green)' : 'var(--text2)' }}>
            {done}/{total} {allDone ? '— All Clear ✓' : 'complete'}
          </span>
          <div className="progress-bar" style={{ width: 140, marginBottom: 0 }}>
            <div className="progress-fill" style={{ width: `${total > 0 ? Math.round((done / total) * 100) : 0}%` }} />
          </div>
        </div>
      </div>
      <div className="checklist-items">
        {DEFAULT_CHECKLIST.map(item => {
          const checked = !!checklist[item.key]
          return (
            <label key={item.key} className={`checklist-item ${checked ? 'checked' : ''}`}>
              <input
                type="checkbox"
                checked={checked}
                onChange={e => onChange(item.key, e.target.checked)}
                style={{ accentColor: 'var(--green)', width: 'auto', flexShrink: 0, margin: 0 }}
              />
              <span className="checklist-item-label">{item.label}</span>
              {checked && <span className="checklist-tick">✓</span>}
            </label>
          )
        })}
      </div>
    </div>
  )
}

// ── Run Panel ──────────────────────────────────────────────────────────────────
const PRIORITY_CHIPS = [
  { key: 'P0', label: 'P0 Critical', cls: 'pri-p0' },
  { key: 'P1', label: 'P1 High',     cls: 'pri-p1' },
  { key: 'P2', label: 'P2 Medium',   cls: 'pri-p2' },
]

function RunPanel({ release, onStatusChange, onNotesChange }) {
  const [expandedId, setExpandedId]     = useState(null)
  const [groupByModule, setGroupByModule] = useState(true)
  const [filterStatus, setFilterStatus]  = useState('all')
  const [filterPriority, setFilterPriority] = useState('all')

  const tcs = release.testCases.filter(tc => {
    const statusOk   = filterStatus   === 'all' || tc.status   === filterStatus
    const priorityOk = filterPriority === 'all' || tc.priority === filterPriority
    return statusOk && priorityOk
  })

  const grouped = tcs.reduce((acc, tc) => {
    const key = groupByModule ? (tc.module || 'Uncategorised') : '__all__'
    if (!acc[key]) acc[key] = []
    acc[key].push(tc)
    return acc
  }, {})

  return (
    <div className="run-panel">
      {/* Toolbar */}
      <div className="run-toolbar">
        <div className="run-toolbar-left">
          {/* Status filter */}
          <div className="filter-chips">
            <button className={`filter-chip ${filterStatus === 'all' ? 'active' : ''}`}
              onClick={() => setFilterStatus('all')}>
              All ({release.testCases.length})
            </button>
            {Object.entries(STATUS_CONFIG).map(([k, cfg]) => {
              const cnt = release.testCases.filter(t => t.status === k).length
              return (
                <button key={k}
                  className={`filter-chip ${filterStatus === k ? 'active' : ''}`}
                  style={filterStatus === k ? { background: cfg.color + '22', color: cfg.color, borderColor: cfg.color + '60' } : {}}
                  onClick={() => setFilterStatus(k)}>
                  {cfg.label} {cnt > 0 && `(${cnt})`}
                </button>
              )
            })}
          </div>
          {/* Priority filter */}
          <div className="filter-chips">
            <button className={`filter-chip ${filterPriority === 'all' ? 'active' : ''}`}
              onClick={() => setFilterPriority('all')}>
              All Priority
            </button>
            {PRIORITY_CHIPS.map(({ key, label, cls }) => {
              const cnt = release.testCases.filter(t => t.priority === key).length
              if (cnt === 0) return null
              return (
                <button key={key}
                  className={`filter-chip ${cls} ${filterPriority === key ? 'active' : ''}`}
                  onClick={() => setFilterPriority(p => p === key ? 'all' : key)}>
                  {label} ({cnt})
                </button>
              )
            })}
          </div>
        </div>
        <button className={`filter-chip ${groupByModule ? 'active' : ''}`}
          style={{ alignSelf: 'flex-start' }}
          onClick={() => setGroupByModule(p => !p)}>
          <Filter size={11} /> Group by module
        </button>
      </div>

      {release.testCases.length === 0 && (
        <div className="empty-state sm">
          <CheckCircle size={24} strokeWidth={1} />
          <p>No test cases selected</p>
          <span>Switch to "Pick Test Cases" to add them</span>
        </div>
      )}

      {tcs.length === 0 && release.testCases.length > 0 && (
        <div className="empty-state sm">
          <Filter size={24} strokeWidth={1} />
          <p>No matches for this filter</p>
        </div>
      )}

      {Object.entries(grouped).map(([groupKey, groupTcs]) => (
        <div key={groupKey}>
          {groupByModule && (
            <div className="run-group-header">
              {groupKey}
              <span>{groupTcs.length}</span>
            </div>
          )}
          {groupTcs.map(tc => {
            const Icon     = STATUS_CONFIG[tc.status]?.icon || Clock
            const color    = STATUS_CONFIG[tc.status]?.color || 'var(--text3)'
            const expanded = expandedId === tc.id
            return (
              <div key={tc.id} className={`run-item status-${tc.status}`}>
                <div className="run-item-header" onClick={() => setExpandedId(expanded ? null : tc.id)}>
                  <div className="run-left">
                    <Icon size={15} color={color} />
                    <PriorityBadge priority={tc.priority} />
                    <span className="tc-id">{tc.id}</span>
                    <span className="tc-title">{tc.title}</span>
                  </div>
                  <div className="run-right" onClick={e => e.stopPropagation()}>
                    {Object.entries(STATUS_CONFIG).map(([k, cfg]) => (
                      <button key={k}
                        className={`status-btn ${tc.status === k ? 'active' : ''}`}
                        style={tc.status === k ? { background: cfg.color + '22', color: cfg.color, borderColor: cfg.color } : {}}
                        onClick={() => onStatusChange(tc.id, k)}>
                        {cfg.label}
                      </button>
                    ))}
                    {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  </div>
                </div>

                {expanded && (
                  <div className="run-item-body">
                    {tc.submodule && (
                      <div className="detail-breadcrumb">
                        <Tag size={11} /> {tc.module} › {tc.submodule}
                      </div>
                    )}
                    {tc.labels && <LabelChips labels={tc.labels} />}

                    {tc.precondition && (
                      <div className="detail-section">
                        <div className="detail-label">Preconditions</div>
                        <div className="detail-text">{tc.precondition}</div>
                      </div>
                    )}
                    {tc.testSteps && (
                      <div className="detail-section">
                        <div className="detail-label">Test Steps</div>
                        <div className="detail-text">{tc.testSteps}</div>
                      </div>
                    )}
                    {tc.expectedResult && (
                      <div className="detail-section">
                        <div className="detail-label">Expected Result</div>
                        <div className="detail-text">{tc.expectedResult}</div>
                      </div>
                    )}

                    <div className="detail-section">
                      <div className="detail-label">Notes / Observations</div>
                      <textarea
                        value={tc.notes || ''}
                        onChange={e => onNotesChange(tc.id, e.target.value)}
                        placeholder="Add notes, bug refs, observations…"
                        rows={3}
                        style={{ marginTop: '4px', resize: 'vertical', fontSize: '12px' }}
                      />
                    </div>
                    {tc.updatedAt && (
                      <span className="updated-at">Last updated: {new Date(tc.updatedAt).toLocaleString()}</span>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}
