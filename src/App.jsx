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
  const missingConfig = validateConfig()

  /**
   * Text used for voice playback of a bot message.
   * Short answers are spoken as-is. Long answers are summarized by
   * GAILexa itself (hidden request) so listening stays quick — in the
   * same language as the answer. If the summary comes back too long or
   * empty, we clamp to the first few sentences instead.
   */
  async function getSpeechText(message) {
    const original = message.text || ''
    if (original.length < 300) return original
    const cached = summaryCacheRef.current[message.id]
    if (cached) return cached

    const isHindi = /[\u0900-\u097F]/.test(original)
    // Fallback if the agent can't be asked right now: first sentences only
    if (!sessionRef.current || status === 'thinking' || status === 'connecting') {
      return clampSentences(original, isHindi)
    }

    const prompt = isHindi
      ? 'पिछले उत्तर का सारांश ठीक 1-2 छोटे वाक्यों में दीजिए। पूरा उत्तर न दोहराएँ। केवल सारांश लिखें — कोई सूची, लिंक या संदर्भ नहीं।'
      : 'Summarize your previous answer in exactly 1-2 short sentences. Do NOT repeat the full answer. Reply with ONLY the summary — no lists, links, or citations.'
    try {
      setStatus('thinking')
      let summary = await sessionRef.current.askHidden(prompt)
      // Guard: if the agent ignored the brief and sent something long
      // (or nothing), clamp to keep playback short.
      if (!summary || summary.length > 450 || summary.length > original.length * 0.7) {
        summary = clampSentences(summary || original, isHindi)
      }
      summaryCacheRef.current[message.id] = summary
      return summary
    } catch (e) {
      console.error('Summary request failed:', e)
      return clampSentences(original, isHindi)
    } finally {
      setStatus('ready')
    }
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
      .then(() => setStatus('ready'))
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
      setMessages((prev) => [
        ...prev,
        {
          id: nextId(),
          role: 'bot',
          text: activity.text || '',
          actions:
            activity.suggestedActions?.actions?.map((a) => a.title || a.value).filter(Boolean) ??
            [],
          at: new Date(),
        },
      ])
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
      await sessionRef.current.send(trimmed, (activity) => handleActivity(activity))
      setStatus('ready')
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
