"use client";

import React from "react";
import { Switch } from "./ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { TooltipProvider } from "./ui/tooltip";

export default function PanelConfig({
  title,
  tooltip,
  enabled,
  setEnabled,
  disabled,
  children,
}: {
  title: string;
  tooltip: string;
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
  disabled?: boolean;
  children?: React.ReactNode;
}) {
  const handleToggle = () => {
    setEnabled(!enabled);
  };

  return (
    <div className="space-y-4 mb-6">
      <div className="flex justify-between items-center">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <h1 className="text-sm font-semibold text-stone-900 dark:text-stone-100">
                {title}
              </h1>
            </TooltipTrigger>
            <TooltipContent className="border border-stone-200 bg-white text-stone-900 shadow-sm dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100">
              <p className="text-xs">{tooltip}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>

        <Switch
          id={title}
          checked={enabled}
          onCheckedChange={handleToggle}
          disabled={disabled}
        />
      </div>

      <div className="mt-1 text-stone-900 dark:text-stone-100">{children}</div>
    </div>
  );
}
