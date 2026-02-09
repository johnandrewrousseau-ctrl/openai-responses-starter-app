/* MESSAGE_IMAGE_TO_NEXT_IMAGE_V1 */
"use client";
import { MessageItem } from "@/lib/assistant";
import React from "react";
import ReactMarkdown from "react-markdown";
import Image from "next/image";
/* MESSAGE_REMOVE_UNUSED_COPY_HELPERS_V1 */

type AnyAnnotation = {
  type?: string;
  file_id?: string;
  fileId?: string;
  filename?: string;
  index?: number;
  container_id?: string;
  containerId?: string;
};

function uniqBy<T>(items: T[], keyFn: (x: T) => string) {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const it of items) {
    const k = keyFn(it);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

interface MessageProps {
  message: MessageItem;
}

// Last-line-of-defense: never render server writeback blocks OR rich-ui marker tokens in the UI
const WB_BLOCK_RE = /BEGIN_WRITEBACK_JSON[\s\S]*?END_WRITEBACK_JSON/g;

// These tokens look like: 
const RICH_UI_MARKER_RE = /\uE200[\s\S]*?\uE201/g;
function stripWritebackBlocks(s: string): string {
  if (!s) return "";
  // Do NOT trim: preserve spacing and markdown formatting
  return s.replace(WB_BLOCK_RE, "").replace(RICH_UI_MARKER_RE, "");
}


function getMessageText(message: MessageItem): string {
  const raw = ((message as any)?.content?.[0]?.text as string) || "";
  return stripWritebackBlocks(raw);
}

function isImageFilename(name?: string) {
  if (!name) return false;
  return /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(name);
}

function getContainerId(a: AnyAnnotation): string {
  return (a.containerId || (a as any).container_id || "") as string;
}

function getFileId(a: AnyAnnotation): string {
  return (a.file_id || a.fileId || "") as string;
}

const Message: React.FC<MessageProps> = ({ message }) => {
  const text = getMessageText(message);

  const c0 = (message as any)?.content?.[0] as any | undefined;
  const annotations = (c0?.annotations as AnyAnnotation[]) ?? [];

  const imageCitations = annotations
    .filter(
      (a) =>
        a?.type === "container_file_citation" &&
        a.filename &&
        isImageFilename(a.filename)
    )
    .map((a) => ({
      filename: a.filename || "",
      fileId: getFileId(a),
      containerId: getContainerId(a),
    }));

  const sourceCitationsRaw = annotations
    .filter((a) => {
      if (a?.type === "file_citation") return true;
      if (a?.type === "container_file_citation" && a.filename) {
        return !isImageFilename(a.filename);
      }
      return false;
    })
    .map((a) => ({
      type: a.type || "",
      filename: a.filename || "(unknown file)",
      // keep index in data (optional) but we will NOT display it
      index: typeof a.index === "number" ? a.index : undefined,
      fileId: getFileId(a),
      containerId: getContainerId(a),
    }));

  // De-dupe by source identity WITHOUT chunk index so repeated chunks collapse.
  const sourceCitations = uniqBy(
    sourceCitationsRaw,
    (c) => `${c.type}|${c.fileId}|${c.containerId}|${c.filename}`
  );

  const isUser = message.role === "user";

  return (
    <div className="text-sm">
      {isUser ? (
        <div className="flex justify-end">
          <div className="ml-4 md:ml-24 max-w-full">
            <div className="rounded-[16px] px-4 py-2 font-light bg-stone-200 text-stone-900 dark:bg-stone-800 dark:text-stone-100">
              <ReactMarkdown
                components={{
                  a: ({ ...props }) => (
                    <a
                      {...props}
                      className="underline underline-offset-2 text-stone-900 hover:opacity-80 dark:text-stone-100"
                      target="_blank"
                      rel="noreferrer"
                    />
                  ),
                  code: ({ children, ...props }) => (
                    <code
                      {...props}
                      className="rounded bg-stone-300 px-1 py-0.5 text-[13px] dark:bg-stone-700"
                    >
                      {children}
                    </code>
                  ),
                  pre: ({ children, ...props }) => (
                    <pre
                      {...props}
                      className="mt-2 overflow-x-auto rounded-lg bg-stone-900 p-3 text-[13px] text-stone-100"
                    >
                      {children}
                    </pre>
                  ),
                }}
              >
                {text}
              </ReactMarkdown>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-col">
          <div className="flex">
            <div className="mr-4 md:mr-24 max-w-full">
              <div className="rounded-[16px] px-4 py-2 font-light bg-white text-stone-900 border border-stone-200 dark:bg-stone-900 dark:text-stone-100 dark:border-stone-800">
                <ReactMarkdown
                  components={{
                    a: ({ ...props }) => (
                      <a
                        {...props}
                        className="underline underline-offset-2 text-stone-900 hover:opacity-80 dark:text-stone-100"
                        target="_blank"
                        rel="noreferrer"
                      />
                    ),
                    code: ({ children, ...props }) => (
                      <code
                        {...props}
                        className="rounded bg-stone-100 px-1 py-0.5 text-[13px] dark:bg-stone-800"
                      >
                        {children}
                      </code>
                    ),
                    pre: ({ children, ...props }) => (
                      <pre
                        {...props}
                        className="mt-2 overflow-x-auto rounded-lg bg-stone-950 p-3 text-[13px] text-stone-100"
                      >
                        {children}
                      </pre>
                    ),
                    blockquote: ({ children, ...props }) => (
                      <blockquote
                        {...props}
                        className="mt-2 border-l-4 border-stone-300 pl-3 text-stone-700 dark:border-stone-700 dark:text-stone-300"
                      >
                        {children}
                      </blockquote>
                    ),
                  }}
                >
                  {text}
                </ReactMarkdown>

                {/* Images (container_file_citation) */}
                {/* Images (container_file_citation) */}
{imageCitations.map((a, i) => (
  <div
    key={`${a.filename}-${a.fileId}-${a.containerId}-${i}`}
    className="mt-2 overflow-hidden rounded-md border border-stone-200 dark:border-stone-800"
  >
    <Image
      src={`/api/container_files/content?file_id=${encodeURIComponent(a.fileId || "")}${
        a.containerId ? `&container_id=${encodeURIComponent(a.containerId)}` : ""
      }${a.filename ? `&filename=${encodeURIComponent(a.filename)}` : ""}`}
      alt={a.filename || ""}
      width={1600}
      height={900}
      className="h-auto w-full"
      unoptimized
    />
  </div>
))}

                {/* Sources (file_citation + non-image container_file_citation) */}
                {sourceCitations.length > 0 && (
                  <div className="mt-3 border-t border-stone-200 pt-2 text-xs text-stone-600 dark:border-stone-800 dark:text-stone-300">
                    <div className="font-medium text-stone-700 dark:text-stone-200">
                      Sources
                    </div>
                    <ul className="mt-1 list-disc pl-5 space-y-1">
                      {sourceCitations.map((c, i) => (
                        <li key={`${c.type}-${c.filename}-${c.fileId}-${c.containerId}-${i}`}>
                          <span className="text-stone-800 dark:text-stone-100">
                            {c.filename}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Message;

