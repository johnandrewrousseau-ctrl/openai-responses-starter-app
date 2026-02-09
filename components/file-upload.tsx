"use client";
import React, { useCallback, useState, FormEvent } from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "./ui/button";
import { FilePlus2, Plus, Trash2, CircleX } from "lucide-react";
import { useDropzone } from "react-dropzone";
import { Input } from "./ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./ui/tooltip";

interface FileUploadProps {
  vectorStoreId?: string;
  vectorStoreName?: string;
  onAddStore: (id: string) => void;
  onUnlinkStore: () => void;
}

export default function FileUpload({
  vectorStoreId,
  onAddStore,
  onUnlinkStore,
}: FileUploadProps) {
  const [file, setFile] = useState<File | null>(null);
  const [newStoreName, setNewStoreName] = useState<string>("Default store");
  const [uploading, setUploading] = useState<boolean>(false);
  const [dialogOpen, setDialogOpen] = useState<boolean>(false);

  const acceptedFileTypes = {
    "text/x-c": [".c"],
    "text/x-c++": [".cpp"],
    "text/x-csharp": [".cs"],
    "text/css": [".css"],
    "application/msword": [".doc"],
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [
      ".docx",
    ],
    "text/x-golang": [".go"],
    "text/html": [".html"],
    "text/x-java": [".java"],
    "text/javascript": [".js"],
    "application/json": [".json"],
    "text/markdown": [".md"],
    "application/pdf": [".pdf"],
    "text/x-php": [".php"],
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": [
      ".pptx",
    ],
    "text/x-python": [".py"],
    "text/x-script.python": [".py"],
    "text/x-ruby": [".rb"],
    "application/x-sh": [".sh"],
    "text/x-tex": [".tex"],
    "application/typescript": [".ts"],
    "text/plain": [".txt"],
  };

  const onDrop = useCallback((acceptedFiles: File[]) => {
    if (acceptedFiles.length > 0) setFile(acceptedFiles[0]);
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    multiple: false,
    accept: acceptedFileTypes,
  });

  const removeFile = () => setFile(null);

  const arrayBufferToBase64 = (buffer: ArrayBuffer) => {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) {
      alert("Please select a file to upload.");
      return;
    }
    setUploading(true);

    try {
      const arrayBuffer = await file.arrayBuffer();
      const base64Content = arrayBufferToBase64(arrayBuffer);
      const fileObject = { name: file.name, content: base64Content };

      // 1) Upload file
      const uploadResponse = await fetch("/api/vector_stores/upload_file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileObject }),
      });
      if (!uploadResponse.ok) throw new Error("Error uploading file");
      const uploadData = await uploadResponse.json();
      const fileId = uploadData.id;
      if (!fileId) throw new Error("Error getting file ID");

      let finalVectorStoreId = vectorStoreId;

      // 2) If no vector store is linked, create one
      if (!vectorStoreId || vectorStoreId === "") {
        const createResponse = await fetch("/api/vector_stores/create_store", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: newStoreName }),
        });
        if (!createResponse.ok) throw new Error("Error creating vector store");
        const createData = await createResponse.json();
        finalVectorStoreId = createData.id;
      }

      if (!finalVectorStoreId) throw new Error("Error getting vector store ID");

      onAddStore(finalVectorStoreId);

      // 3) Add file to vector store
      const addFileResponse = await fetch("/api/vector_stores/add_file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileId, vectorStoreId: finalVectorStoreId }),
      });
      if (!addFileResponse.ok) throw new Error("Error adding file to vector store");

      setFile(null);
      setDialogOpen(false);
    } catch (error) {
      console.error("Error during file upload process:", error);
      alert("There was an error processing your file. Please try again.");
    } finally {
      setUploading(false);
    }
  };

  const triggerCls = [
    "inline-flex items-center justify-center gap-1 rounded-full px-3 py-1 text-sm font-semibold border transition-colors",
    "border-stone-200 bg-white text-stone-900 hover:bg-stone-50",
    "dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100 dark:hover:bg-stone-800",
  ].join(" ");

  const panelTextMuted = "text-stone-600 dark:text-stone-300";
  const panelText = "text-stone-900 dark:text-stone-100";

  const inputCls = [
    "border rounded p-2",
    "bg-white text-stone-900 placeholder:text-stone-400 border-stone-200",
    "dark:bg-stone-900 dark:text-stone-100 dark:placeholder:text-stone-500 dark:border-stone-700",
    "focus-visible:ring-0",
  ].join(" ");

  return (
    <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
      <DialogTrigger asChild>
        <button type="button" className={triggerCls}>
          <Plus size={16} />
          Upload
        </button>
      </DialogTrigger>

      <DialogContent className="sm:max-w-[500px] md:max-w-[600px] max-h-[80vh] overflow-y-auto border border-stone-200 bg-white text-stone-900 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle className="text-stone-900 dark:text-stone-100">
              Add files to your vector store
            </DialogTitle>
          </DialogHeader>

          <div className="my-6">
            {!vectorStoreId || vectorStoreId === "" ? (
              <div className="flex items-start gap-2 text-sm">
                <label className="font-medium w-72" htmlFor="storeName">
                  <div className={panelText}>New vector store name</div>
                  <div className="text-xs text-stone-500 dark:text-stone-400">
                    A new store will be created when you upload a file.
                  </div>
                </label>
                <Input
                  id="storeName"
                  type="text"
                  value={newStoreName}
                  onChange={(e) => setNewStoreName(e.target.value)}
                  className={inputCls}
                />
              </div>
            ) : (
              <div className="flex items-center justify-between flex-1 min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  <div className="text-sm font-medium w-24 text-nowrap text-stone-700 dark:text-stone-300">
                    Vector store
                  </div>
                  <div className="text-stone-500 dark:text-stone-400 text-xs font-mono flex-1 text-ellipsis truncate">
                    {vectorStoreId}
                  </div>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <CircleX
                          onClick={() => onUnlinkStore()}
                          size={16}
                          className="cursor-pointer text-stone-500 dark:text-stone-400 mb-0.5 shrink-0 mt-0.5 hover:text-stone-900 dark:hover:text-stone-100 transition-colors"
                        />
                      </TooltipTrigger>
                      <TooltipContent className="border border-stone-200 bg-white text-stone-900 shadow-sm dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100">
                        <p className="text-xs">Unlink vector store</p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
              </div>
            )}
          </div>

          <div className="flex justify-center items-center mb-4 h-[200px]">
            {file ? (
              <div className="flex flex-col items-start">
                <div className={panelTextMuted}>Loaded file</div>
                <div className="flex items-center mt-2">
                  <div className="mr-2 text-stone-900 dark:text-stone-100">
                    {file.name}
                  </div>
                  <Trash2
                    onClick={removeFile}
                    size={16}
                    className="cursor-pointer text-stone-700 hover:text-stone-900 dark:text-stone-300 dark:hover:text-stone-100"
                  />
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center w-full">
                <div
                  {...getRootProps()}
                  className={[
                    "w-full rounded-xl border border-dashed p-6",
                    "border-stone-200 bg-stone-50 hover:bg-stone-100",
                    "dark:border-stone-700 dark:bg-stone-900/40 dark:hover:bg-stone-900/60",
                    "flex items-center justify-center relative focus-visible:outline-0 cursor-pointer transition-colors",
                  ].join(" ")}
                >
                  <input {...getInputProps()} />
                  <div
                    className={[
                      "absolute rounded-full transition-all duration-300",
                      isDragActive
                        ? "h-56 w-56 bg-stone-200/60 dark:bg-stone-800/60"
                        : "h-0 w-0 bg-transparent",
                    ].join(" ")}
                  />
                  <div className="flex flex-col items-center text-center z-10">
                    <FilePlus2 className="mb-4 size-8 text-stone-700 dark:text-stone-200" />
                    <div className="text-stone-800 dark:text-stone-100 font-medium">
                      Upload a file
                    </div>
                    <div className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                      Drag & drop or click to choose
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button type="submit" disabled={uploading}>
              {uploading ? "Uploading..." : "Add"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
