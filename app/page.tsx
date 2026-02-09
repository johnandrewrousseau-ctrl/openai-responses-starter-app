"use client";
import Assistant from "@/components/assistant";
import ToolsPanel from "@/components/tools-panel";
import { Menu, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import useConversationStore from "@/stores/useConversationStore";

export default function Main() {
  const [isToolsPanelOpen, setIsToolsPanelOpen] = useState(false);
  const router = useRouter();
  const { resetConversation } = useConversationStore();

  // After OAuth redirect, reinitialize the conversation so the next turn
  // uses the connector-enabled server configuration immediately
  useEffect(() => {
    if (typeof window === "undefined") return;
    const isConnected = new URLSearchParams(window.location.search).get("connected");
    if (isConnected === "1") {
      resetConversation();
      router.replace("/", { scroll: false });
    }
  }, [router, resetConversation]);

  return (
    <div className="flex justify-center h-screen bg-stone-100 text-stone-900 dark:bg-stone-950 dark:text-stone-100">
      <div className="w-full md:w-[70%] h-full">
        <Assistant />
      </div>

      <div className="hidden md:block w-[30%] h-full">
        <ToolsPanel />
      </div>

      {/* Hamburger menu for small screens */}
      <div className="absolute top-4 right-4 md:hidden">
        <button
          onClick={() => setIsToolsPanelOpen(true)}
          className="rounded-md border border-stone-200 bg-white p-2 text-stone-900 hover:bg-stone-50 dark:border-stone-800 dark:bg-stone-900 dark:text-stone-100 dark:hover:bg-stone-800"
        >
          <Menu size={24} />
        </button>
      </div>

      {/* Overlay panel for ToolsPanel on small screens */}
      {isToolsPanelOpen && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/40">
          <div className="w-full h-full p-4 bg-white dark:bg-stone-950">
            <button
              className="mb-4 rounded-md border border-stone-200 bg-white p-2 text-stone-900 hover:bg-stone-50 dark:border-stone-800 dark:bg-stone-900 dark:text-stone-100 dark:hover:bg-stone-800"
              onClick={() => setIsToolsPanelOpen(false)}
            >
              <X size={24} />
            </button>
            <ToolsPanel />
          </div>
        </div>
      )}
    </div>
  );
}
