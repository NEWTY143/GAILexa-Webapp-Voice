import { useEffect, useRef, useState } from 'react'

/**
 * Voice input via the browser's built-in Web Speech API.
 * No server, no API key — recognition runs in the browser (Chrome/Edge).
 *
 * Usage:
 *   const { supported, listening, toggle } = useSpeechInput({
 *     lang: 'en-IN',
 *     onTranscript: (text, isFinal) => ...,
 *   })
 */
export function useSpeechInput({ lang = 'en-IN', onTranscript }) {
  const [listening, setListening] = useState(false)
  const recognitionRef = useRef(null)
  const callbackRef = useRef(onTranscript)
  callbackRef.current = onTranscript

  const SR =
    typeof window !== 'undefined'
      ? window.SpeechRecognition || window.webkitSpeechRecognition
      : undefined
  const supported = Boolean(SR)

  useEffect(() => {
    return () => recognitionRef.current?.abort()
  }, [])

  function stop() {
    recognitionRef.current?.stop()
  }

  function start() {
    if (!SR || listening) return
    const rec = new SR()
    rec.lang = lang
    rec.interimResults = true // show words as they are spoken
    rec.continuous = false // stop automatically after a pause

    rec.onresult = (event) => {
      let transcript = ''
      let isFinal = false
      for (const result of event.results) {
        transcript += result[0].transcript
        if (result.isFinal) isFinal = true
      }
      callbackRef.current?.(transcript.trim(), isFinal)
    }
    rec.onend = () => setListening(false)
    rec.onerror = (e) => {
      console.warn('Speech recognition error:', e.error)
      setListening(false)
    }

    recognitionRef.current = rec
    setListening(true)
    rec.start()
  }

  function toggle() {
    listening ? stop() : start()
  }

  return { supported, listening, toggle }
}
