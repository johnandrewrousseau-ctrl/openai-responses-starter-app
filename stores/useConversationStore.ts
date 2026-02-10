import { create } from "zustand";
import { Item } from "@/lib/assistant";
import { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { INITIAL_MESSAGE } from "@/config/constants";

export type RunMode = "normal" | "canon" | "threads" | "gold";

interface ConversationState {
  // Items displayed in the chat
  chatMessages: Item[];
  // Items sent to the Responses API
  conversationItems: any[];
  // Whether we are waiting for the assistant response
  isAssistantLoading: boolean;
  // Runner mode for routing (UI only)
  runMode: RunMode;

  setChatMessages: (items: Item[]) => void;
  setConversationItems: (messages: any[]) => void;
  addChatMessage: (item: Item) => void;
  addConversationItem: (message: ChatCompletionMessageParam) => void;
  setAssistantLoading: (loading: boolean) => void;
  setRunMode: (mode: RunMode) => void;
  rawSet: (state: any) => void;
  resetConversation: () => void;
}

const useConversationStore = create<ConversationState>((set) => ({
  chatMessages: [
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: INITIAL_MESSAGE }],
    },
  ],
  conversationItems: [],
  isAssistantLoading: false,
  runMode: "normal",
  setChatMessages: (items) => set({ chatMessages: items }),
  setConversationItems: (messages) => set({ conversationItems: messages }),
  addChatMessage: (item) =>
    set((state) => ({ chatMessages: [...state.chatMessages, item] })),
  addConversationItem: (message) =>
    set((state) => ({
      conversationItems: [...state.conversationItems, message],
    })),
  setAssistantLoading: (loading) => set({ isAssistantLoading: loading }),
  setRunMode: (mode) => set({ runMode: mode }),
  rawSet: set,
  resetConversation: () =>
    set(() => ({
      chatMessages: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: INITIAL_MESSAGE }],
        },
      ],
      conversationItems: [],
    })),
}));

export default useConversationStore;
