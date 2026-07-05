import { useEffect, useRef, useState } from 'react'
import { getAccount, signIn, signOut } from './auth.js'
import { GailexaSession } from './copilot.js'
import { validateConfig } from './config.js'
import SignIn from './components/SignIn.jsx'
import Chat from './components/Chat.jsx'

let messageCounter = 0
const nextId = () => `m-${++messageCounter}`

export default function App() {
  const [account, setAccount] = useState(null)
  const [booting, setBooting] = useState(true)
  const [messages, setMessages] = useState([])
  const [status, setStatus] = useState('idle') // idle | connecting | ready | thinking | error
  const [error, setError] = useState(null)
  const sessionRef = useRef(null)
  const summaryCacheRef = useRef({})
  const summaryJobsRef = useRef({}) // in-flight prefetch promises by message id
  const lastBotRef = useRef(null)
  const missingConfig = validateConfig()

  /**
   * Prepare the spoken version of a bot message in the BACKGROUND, as soon
   * as the answer arrives — so tapping play is instant. Short answers are
   * cached as-is; long ones are summarized by GAILexa via a hidden request.
   */
  function prefetchSummary(message) {
    const id = message.id
    if (summaryCacheRef.current[id]) return null
    if (summaryJobsRef.current[id]) return summaryJobsRef.current[id]

    const original = message.text || ''
    const isHindi = /[\u0900-\u097F]/.test(original)
    if (original.length < 300) {
      summaryCacheRef.current[id] = original
      return null
    }

    const prompt = isHindi
      ? 'पिछले उत्तर का सारांश ठीक 1-2 छोटे वाक्यों में दीजिए। पूरा उत्तर न दोहराएँ। केवल सारांश लिखें — कोई सूची, लिंक या संदर्भ नहीं।'
      : 'Summarize your previous answer in exactly 1-2 short sentences. Do NOT repeat the full answer. Reply with ONLY the summary — no lists, links, or citations.'

    const job = (async () => {
      try {
        let summary = await sessionRef.current.askHidden(prompt)
        if (!summary || summary.length > 450 || summary.length > original.length * 0.7) {
          summary = clampSentences(summary || original, isHindi)
        }
        summaryCacheRef.current[id] = summary
      } catch (e) {
        console.error('Summary prefetch failed:', e)
        summaryCacheRef.current[id] = clampSentences(original, isHindi)
      } finally {
        delete summaryJobsRef.current[id]
      }
    })()
    summaryJobsRef.current[id] = job
    return job
  }

  /** Wait for any hidden summary request to finish before a new user turn,
   *  so two messages never stream through the conversation at once. */
  async function drainSummaryJobs() {
    const jobs = Object.values(summaryJobsRef.current)
    if (jobs.length) await Promise.allSettled(jobs)
  }

  /**
   * Text for voice playback. Usually already cached by prefetchSummary —
   * so this returns instantly. Falls back to on-demand prep if not.
   */
  async function getSpeechText(message) {
    const cached = summaryCacheRef.current[message.id]
    if (cached) return cached
    const job = summaryJobsRef.current[message.id] || prefetchSummary(message)
    if (job) await job
    return (
      summaryCacheRef.current[message.id] ??
      clampSentences(message.text || '', /[\u0900-\u097F]/.test(message.text || ''))
    )
  }

  // Restore a signed-in account on page load
  useEffect(() => {
    getAccount()
      .then((acc) => setAccount(acc))
      .finally(() => setBooting(false))
  }, [])

  // Once signed in, open the conversation
  useEffect(() => {
    if (!account || sessionRef.current) return
    const session = new GailexaSession()
    sessionRef.current = session
    setStatus('connecting')
    session
      .start((activity) => handleActivity(activity))
      .then(() => {
        setStatus('ready')
        if (lastBotRef.current) prefetchSummary(lastBotRef.current)
      })
      .catch((e) => {
        console.error(e)
        setError(describeError(e))
        setStatus('error')
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account])

  function handleActivity(activity) {
    if (!activity || !activity.type) return
    if (activity.type === 'message' && (activity.text || activity.suggestedActions)) {
      const botMessage = {
          id: nextId(),
          role: 'bot',
          text: activity.text || '',
          actions:
            activity.suggestedActions?.actions?.map((a) => a.title || a.value).filter(Boolean) ??
            [],
          at: new Date(),
      }
      lastBotRef.current = botMessage
      setMessages((prev) => [...prev, botMessage])
    }
  }

  async function handleSignIn() {
    setError(null)
    try {
      const acc = await signIn()
      setAccount(acc)
    } catch (e) {
      console.error(e)
      setError(describeError(e))
    }
  }

  async function handleSignOut() {
    await signOut()
    sessionRef.current = null
    setAccount(null)
    setMessages([])
    setStatus('idle')
  }

  async function handleSend(text) {
    const trimmed = text.trim()
    if (!trimmed || status === 'thinking' || status === 'connecting') return
    setError(null)
    setMessages((prev) => [
      ...prev,
      { id: nextId(), role: 'user', text: trimmed, at: new Date() },
    ])
    setStatus('thinking')
    try {
      await drainSummaryJobs() // never overlap a hidden request with a user turn
      await sessionRef.current.send(trimmed, (activity) => handleActivity(activity))
      setStatus('ready')
      // Fire-and-forget: prepare the voice summary while the user reads
      if (lastBotRef.current) prefetchSummary(lastBotRef.current)
    } catch (e) {
      console.error(e)
      setError(describeError(e))
      setStatus('ready')
    }
  }

  if (booting) return <div className="boot" />

  if (!account) {
    return (
      <SignIn
        onSignIn={handleSignIn}
        error={error}
        missingConfig={missingConfig}
      />
    )
  }

  return (
    <Chat
      account={account}
      messages={messages}
      status={status}
      error={error}
      onSend={handleSend}
      onSignOut={handleSignOut}
      getSpeechText={getSpeechText}
    />
  )
}

/**
 * Take the first 2 sentences (max ~350 chars) — the safety net when a
 * summary is unavailable or comes back too long. Handles the Hindi
 * full stop (।) as well as . ! ?
 */
function clampSentences(text, isHindi) {
  const plain = (text || '').replace(/\s+/g, ' ').trim()
  const parts = plain.split(isHindi ? /(?<=[।.!?])\s+/ : /(?<=[.!?])\s+/)
  let out = ''
  for (const p of parts) {
    if (out && (out + ' ' + p).length > 350) break
    out = out ? out + ' ' + p : p
    if (out.split(/[।.!?]/).length > 2) break
  }
  return out || plain.slice(0, 350)
}

function describeError(e) {
  const msg = String(e?.message || e || 'Something went wrong.')
  if (msg.includes('AADSTS')) {
    return `Microsoft sign-in failed: ${msg}. Check the app registration, redirect URI, and API permissions.`
  }
  if (msg.toLowerCase().includes('failed to fetch')) {
    return 'Could not reach Copilot Studio. Check the connection string and your network, then try again.'
  }
  return msg
}
