"use client";
// PREVIEW-SMOKE-TEST
// HASH-MISMATCH-B: marker
// HASH-MISMATCH-TEST: marker



import React, { useCallback, useEffect, useRef, useState } from "react";
import ToolCall from "./tool-call";
import Message from "./message";
import Annotations from "./annotations";
import McpToolsList from "./mcp-tools-list";
import McpApproval from "./mcp-approval";
import { Item, McpApprovalRequestItem } from "@/lib/assistant";
import LoadingMessage from "./loading-message";
import useConversationStore from "@/stores/useConversationStore";
import { Mic, MicOff } from "lucide-react";

interface ChatProps {
  items: Item[];
  onSendMessage: (message: string) => void;
  onApprovalResponse: (approve: boolean, id: string) => void;
}

type SpeechRecognitionCtor = new () => any;

const Chat: React.FC<ChatProps> = ({ items, onSendMessage, onApprovalResponse }) => {
  const itemsEndRef = useRef<HTMLDivElement>(null);

  const [inputMessageText, setinputMessageText] = useState<string>("");
  const [isComposing, setIsComposing] = useState(false);
  const { isAssistantLoading } = useConversationStore();

  // ---- Speech-to-text (Chrome Web Speech API) ----
  const [sttSupported, setSttSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [sttStatus, setSttStatus] = useState<string>("");

  const recognitionRef = useRef<any | null>(null);
  const listeningRef = useRef<boolean>(false);

  // Transcript state refs
  const finalTranscriptRef = useRef<string>("");
  const lastInterimRef = useRef<string>("");

  // Stop/punctuate coordination
  const stoppingRef = useRef<boolean>(false);
  const pendingPunctuateOnEndRef = useRef<boolean>(false);
  const stopSnapshotRef = useRef<string>("");

  const scrollToBottom = () => {
    itemsEndRef.current?.scrollIntoView({ behavior: "instant" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [items]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const w = window as any;
    const ctor: SpeechRecognitionCtor | undefined = w.SpeechRecognition || w.webkitSpeechRecognition;
    setSttSupported(Boolean(ctor));
  }, []);

  const emitTextbox = (text: string) => setinputMessageText(text);

  const punctuateOnStop = async (raw: string) => {
    const text = (raw || "").trim();
    if (!text) return raw;

    try {
      const r = await fetch("/api/punctuate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!r.ok) return raw;

      const j = await r.json();

      // Accept both shapes:
      // 1) { ok: true, text: "..." }  (preferred)
      // 2) { text: "..." }           (current behavior seen in PowerShell)
      if (typeof j?.text === "string" && j.text.trim()) return j.text;

      return raw;
    } catch {
      return raw;
    }
  };

  const buildRecognizer = (): any | null => {
    if (typeof window === "undefined") return null;
    const w = window as any;
    const ctor: SpeechRecognitionCtor | undefined = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!ctor) return null;

    const rec = new ctor();

    rec.interimResults = true;
    rec.continuous = true;
    rec.lang = "en-US";

    rec.onstart = () => setSttStatus("Listening…");

    rec.onerror = (e: any) => {
      setSttStatus(`Mic error: ${String(e?.error ?? "unknown")}`);
    };

    rec.onresult = (event: any) => {
      // Critical: prevent late events after Stop from overwriting punctuated text.
      if (stoppingRef.current) return;

      let interim = "";
      let finalAdd = "";

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const r = event.results[i];
        const t = (r[0]?.transcript ?? "").toString();
        if (r.isFinal) finalAdd += t;
        else interim += t;
      }

      if (finalAdd.trim()) {
        const base = finalTranscriptRef.current.trim();
        finalTranscriptRef.current = (base ? base + " " : "") + finalAdd.trim();
      }

      lastInterimRef.current = interim;

      // IMPORTANT: inputMessageText is derived from refs only. Do not re-add inputMessageText here.
      const composed = [finalTranscriptRef.current.trim(), interim.trim()].filter(Boolean).join(" ");
      emitTextbox(composed);
    };

    rec.onend = async () => {
      // If still listening (user didn't click stop), auto-restart.
      if (listeningRef.current) {
        setSttStatus("Continuing…");
        setTimeout(() => {
          try {
            rec.start();
          } catch {
            setTimeout(() => {
              try {
                rec.start();
              } catch {
                listeningRef.current = false;
                setListening(false);
                stoppingRef.current = false;
                pendingPunctuateOnEndRef.current = false;
                setSttStatus("Stopped.");
              }
            }, 350);
          }
        }, 150);
        return;
      }

      // We are stopped: finalize + punctuate here
      setSttStatus("Stopped.");

      if (!pendingPunctuateOnEndRef.current) {
        stoppingRef.current = false;
        return;
      }

      pendingPunctuateOnEndRef.current = false;

      const snap = (stopSnapshotRef.current || "").trim();
      if (!snap) {
        stoppingRef.current = false;
        return;
      }

      const punctuated = await punctuateOnStop(snap);

      // Commit punctuated text to transcript refs so the app state matches the textbox.
      finalTranscriptRef.current = (punctuated || "").trim();
      lastInterimRef.current = "";
      stopSnapshotRef.current = "";

      emitTextbox(finalTranscriptRef.current);
      stoppingRef.current = false;
    };

    return rec;
  };

  const startDictation = async () => {
    if (!sttSupported) return;
    if (listeningRef.current) return;

    // Clear stop coordination flags
    stoppingRef.current = false;
    pendingPunctuateOnEndRef.current = false;
    stopSnapshotRef.current = "";

    // Seed transcript with whatever is already in the box (optional but useful)
    finalTranscriptRef.current = inputMessageText.trim();
    lastInterimRef.current = "";

    const rec = buildRecognizer();
    if (!rec) return;

    recognitionRef.current = rec;
    listeningRef.current = true;
    setListening(true);
    setSttStatus("Starting…");

    try {
      rec.start();
    } catch {
      listeningRef.current = false;
      setListening(false);
      setSttStatus("Could not start mic.");
    }
  };

  const stopDictation = async () => {
    if (!listeningRef.current) return;

    // Freeze what we have BEFORE stopping.
    // DO NOT include inputMessageText here (it already contains final+interim and will cause duplication).
    const finalPart = finalTranscriptRef.current.trim();
    const interimPart = lastInterimRef.current.trim();

    const composed = [finalPart, interimPart]
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    stopSnapshotRef.current = composed;
    pendingPunctuateOnEndRef.current = true;

    // Block any late onresult overwrites while we stop + punctuate
    stoppingRef.current = true;

    listeningRef.current = false;
    setListening(false);
    setSttStatus("Stopping…");

    const rec = recognitionRef.current;
    recognitionRef.current = null;

    try {
      rec?.stop();
    } catch {
      // ignore
    }
  };

  const toggleDictation = async () => {
    if (listeningRef.current) await stopDictation();
    else await startDictation();
  };
  // ---- End STT ----

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Enter" && !event.shiftKey && !isComposing) {
        event.preventDefault();
        onSendMessage(inputMessageText);
        setinputMessageText("");
        finalTranscriptRef.current = "";
        lastInterimRef.current = "";
        stoppingRef.current = false;
        pendingPunctuateOnEndRef.current = false;
        stopSnapshotRef.current = "";
      }
    },
    [onSendMessage, inputMessageText, isComposing]
  );

  return (
    <div className="flex justify-center items-center size-full">
      <div className="flex grow flex-col h-full max-w-[750px] gap-2">
        <div className="h-[90vh] overflow-y-scroll px-10 flex flex-col">
          <div className="mt-auto space-y-5 pt-4">
            {items.map((item, index) => (
              <React.Fragment key={index}>
                {item.type === "tool_call" ? (
                  <ToolCall toolCall={item} />
                ) : item.type === "message" ? (
                  <div className="flex flex-col gap-1">
                    <Message message={item} />
                    {item.content &&
                      item.content[0].annotations &&
                      item.content[0].annotations.length > 0 && (
                        <Annotations annotations={item.content[0].annotations} />
                      )}
                  </div>
                ) : item.type === "mcp_list_tools" ? (
                  <McpToolsList item={item} />
                ) : item.type === "mcp_approval_request" ? (
                  <McpApproval
                    item={item as McpApprovalRequestItem}
                    onRespond={onApprovalResponse}
                  />
                ) : null}
              </React.Fragment>
            ))}
            {isAssistantLoading && <LoadingMessage />}
            <div ref={itemsEndRef} />
          </div>
        </div>

        <div className="flex-1 p-4 px-10">
          <div className="flex items-center">
            <div className="flex w-full items-center pb-4 md:pb-1">
              <div className="flex w-full flex-col gap-1.5 rounded-[20px] p-2.5 pl-1.5 transition-colors border border-stone-200 dark:border-stone-800 shadow-sm bg-white/70 dark:bg-stone-950/60">
                <div className="flex items-end gap-1.5 md:gap-2 pl-4">
                  <div className="flex min-w-0 flex-1 flex-col">
                    <textarea
                      id="prompt-textarea"
                      tabIndex={0}
                      dir="auto"
                      rows={2}
                      placeholder="Message..."
                      className="mb-2 resize-none border-0 focus:outline-none text-sm bg-transparent px-0 pb-6 pt-2 text-stone-900 dark:text-stone-100 placeholder:text-stone-500 dark:placeholder:text-stone-500"
                      value={inputMessageText}
                      onChange={(e) => setinputMessageText(e.target.value)}
                      onKeyDown={handleKeyDown}
                      onCompositionStart={() => setIsComposing(true)}
                      onCompositionEnd={() => setIsComposing(false)}
                    />
                    {listening && (
                      <div className="text-[11px] text-stone-500 dark:text-stone-400 -mt-4 pb-2">
                        {sttStatus || "Listening…"}
                      </div>
                    )}
                  </div>

                  <button
                    type="button"
                    disabled={!sttSupported}
                    title={
                      sttSupported
                        ? listening
                          ? "Stop dictation"
                          : "Start dictation"
                        : "Speech-to-text not supported"
                    }
                    className={[
                      "flex size-8 items-center justify-center rounded-full transition-colors",
                      sttSupported
                        ? listening
                          ? "bg-rose-600 text-white hover:opacity-80"
                          : "bg-stone-200 text-stone-900 hover:bg-stone-300 dark:bg-stone-800 dark:text-stone-100 dark:hover:bg-stone-700"
                        : "bg-stone-100 text-stone-400 dark:bg-stone-900 dark:text-stone-600 cursor-not-allowed",
                    ].join(" ")}
                    onClick={toggleDictation}
                  >
                    {listening ? <MicOff size={18} /> : <Mic size={18} />}
                  </button>

                  <button
                    disabled={!inputMessageText}
                    data-testid="send-button"
                    className="flex size-8 items-end justify-center rounded-full bg-black text-white transition-colors hover:opacity-70 focus-visible:outline-none focus-visible:outline-black disabled:bg-[#D7D7D7] disabled:text-[#f4f4f4] disabled:hover:opacity-100"
                    onClick={() => {
                      onSendMessage(inputMessageText);
                      setinputMessageText("");
                      finalTranscriptRef.current = "";
                      lastInterimRef.current = "";
                      stoppingRef.current = false;
                      pendingPunctuateOnEndRef.current = false;
                      stopSnapshotRef.current = "";
                    }}
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width="32"
                      height="32"
                      fill="none"
                      viewBox="0 0 32 32"
                      className="icon-2xl"
                    >
                      <path
                        fill="currentColor"
                        fillRule="evenodd"
                        d="M15.192 8.906a1.143 1.143 0 0 1 1.616 0l5.143 5.143a1.143 1.143 0 0 1-1.616 1.616l-3.192-3.192v9.813a1.143 1.143 0 0 1-2.286 0v-9.813l-3.192 3.192a1.143 1.143 0 1 1-1.616-1.616z"
                        clipRule="evenodd"
                      />
                    </svg>
                  </button>
                </div>

                {!sttSupported && (
                  <div className="pl-4 pb-2 text-[11px] text-stone-500 dark:text-stone-500">
                    Speech-to-text requires Chrome SpeechRecognition (not available in this browser/runtime).
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Chat;
