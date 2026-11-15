"use client";

/**
 * Optional voice input through the browser's Web Speech API. Feature-detected
 * after mount: browsers without it simply don't show the microphone button.
 * Audio is handled by the browser; DealMind only receives the transcript.
 */
import { useCallback, useEffect, useRef, useState } from "react";

interface RecognitionResultEvent {
  results: ArrayLike<ArrayLike<{ transcript: string }>>;
}
interface Recognition {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((e: RecognitionResultEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}
type RecognitionCtor = new () => Recognition;

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const ERROR_TEXT: Record<string, string> = {
  "not-allowed": "Microphone access was blocked. Allow it in your browser to search by voice.",
  "no-speech": "No speech was heard. Try again.",
  "audio-capture": "No microphone was found.",
  network: "Voice recognition needs a network connection.",
};

export function useVoiceInput(onTranscript: (text: string) => void) {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<Recognition | null>(null);

  useEffect(() => {
    setSupported(recognitionCtor() !== null);
    return () => ref.current?.stop();
  }, []);

  const start = useCallback(() => {
    const Ctor = recognitionCtor();
    if (!Ctor) return;
    setError(null);
    const r = new Ctor();
    r.lang = "en-IN";
    r.interimResults = false;
    r.maxAlternatives = 1;
    r.onresult = (e) => {
      const text = e.results[0]?.[0]?.transcript.trim();
      if (text) onTranscript(text);
    };
    r.onerror = (e) => {
      if (e.error !== "aborted") setError(ERROR_TEXT[e.error] ?? "Voice input stopped.");
    };
    r.onend = () => setListening(false);
    ref.current = r;
    setListening(true);
    r.start();
  }, [onTranscript]);

  const stop = useCallback(() => ref.current?.stop(), []);

  return { supported, listening, error, start, stop };
}
