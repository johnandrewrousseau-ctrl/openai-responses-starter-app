"use client";

import React from "react";
import Chat from "./chat";
import useConversationStore from "@/stores/useConversationStore";
import { Item, processMessages } from "@/lib/assistant";

/* ASSISTANT_REMOVE_UNUSED_COPY_HELPERS_V1 */


export default function Assistant() {
  const { chatMessages, addConversationItem, addChatMessage, setAssistantLoading, runMode } =
    useConversationStore();

  const handleSendMessage = async (message: string) => {
    const text = (message || "").trim();
    if (!text) return;

    const header =
      runMode === "canon"
        ? "CANON_QUERY_RUNNER"
        : runMode === "threads"
          ? "THREAD_QUERY_RUNNER"
          : runMode === "gold"
            ? "GOLD_HUNT_RUNNER"
            : "";
    const wireContent = header ? `${header}\nQuestion: ${text}` : text;

    const userItem: Item = {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text }],
    };

    const userMessage: any = {
      role: "user",
      content: wireContent,
    };

    try {
      setAssistantLoading(true);
      addConversationItem(userMessage);
      addChatMessage(userItem);
      await processMessages();
    } catch (error) {
      console.error("Error processing message:", error);
    }
  };

  const handleApprovalResponse = async (approve: boolean, id: string) => {
    const approvalItem = {
      type: "mcp_approval_response",
      approve,
      approval_request_id: id,
    } as any;

    try {
      addConversationItem(approvalItem);
      await processMessages();
    } catch (error) {
      console.error("Error sending approval response:", error);
    }
  };

  return (
    <div className="h-full w-full bg-white text-stone-900 dark:bg-stone-950 dark:text-stone-100">
      <Chat
        items={chatMessages}
        onSendMessage={handleSendMessage}
        onApprovalResponse={handleApprovalResponse}
      />
    </div>
  );
}
