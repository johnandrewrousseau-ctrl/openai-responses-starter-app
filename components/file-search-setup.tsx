"use client";
import React, { useState } from "react";
import useToolsStore from "@/stores/useToolsStore";
import FileUpload from "@/components/file-upload";
import { Input } from "./ui/input";
import { CircleX } from "lucide-react";
import { TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { Tooltip } from "./ui/tooltip";
import { TooltipProvider } from "./ui/tooltip";

export default function FileSearchSetup() {
  const { vectorStore, setVectorStore } = useToolsStore();
  const [newStoreId, setNewStoreId] = useState<string>("");

  const unlinkStore = async () => {
    setVectorStore({ id: "", name: "" });
  };

  const handleAddStore = async (storeId: string) => {
    if (storeId.trim()) {
      const newStore = await fetch(
        `/api/vector_stores/retrieve_store?vector_store_id=${storeId}`
      ).then((res) => res.json());

      if (newStore.id) {
        setVectorStore(newStore);
      } else {
        alert("Vector store not found");
      }
    }
  };

  return (
    <div className="text-stone-900 dark:text-stone-100">
      <div className="text-sm text-stone-600 dark:text-stone-300">
        Upload a file to create a new vector store, or use an existing one.
      </div>

      <div className="flex items-center gap-2 mt-2 h-10">
        <div className="flex items-center gap-2 w-full">
          <div className="text-sm font-medium w-24 text-nowrap text-stone-700 dark:text-stone-300">
            Vector store
          </div>

          {vectorStore?.id ? (
            <div className="flex items-center justify-between flex-1 min-w-0">
              <div className="flex items-center gap-2 min-w-0">
                <div className="text-stone-500 dark:text-stone-400 text-xs font-mono flex-1 text-ellipsis truncate">
                  {vectorStore.id}
                </div>

                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <CircleX
                        onClick={() => unlinkStore()}
                        size={16}
                        className="cursor-pointer text-stone-500 dark:text-stone-400 mb-0.5 shrink-0 mt-0.5 hover:text-stone-800 dark:hover:text-stone-200 transition-colors"
                      />
                    </TooltipTrigger>
                    <TooltipContent className="border border-stone-200 bg-white text-stone-900 shadow-sm dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100">
                      <p className="text-xs">Unlink vector store</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Input
                type="text"
                placeholder="ID (vs_XXXX...)"
                value={newStoreId}
                onChange={(e) => setNewStoreId(e.target.value)}
                className={[
                  "border rounded text-sm",
                  "bg-white text-stone-900 placeholder:text-stone-400 border-stone-200",
                  "dark:bg-stone-900 dark:text-stone-100 dark:placeholder:text-stone-500 dark:border-stone-700",
                  "focus-visible:ring-0",
                ].join(" ")}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleAddStore(newStoreId);
                }}
              />

              <button
                type="button"
                className={[
                  "text-sm font-semibold px-2 py-1 rounded-md border transition-colors",
                  "border-stone-200 bg-white text-stone-900 hover:bg-stone-50",
                  "dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100 dark:hover:bg-stone-800",
                ].join(" ")}
                onClick={() => handleAddStore(newStoreId)}
              >
                Add
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="flex mt-4">
        <FileUpload
          vectorStoreId={vectorStore?.id ?? ""}
          vectorStoreName={vectorStore?.name ?? ""}
          onAddStore={(id) => handleAddStore(id)}
          onUnlinkStore={() => unlinkStore()}
        />
      </div>
    </div>
  );
}
