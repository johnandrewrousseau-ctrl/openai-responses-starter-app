"use client";

import React from "react";
import useToolsStore from "@/stores/useToolsStore";
import { Input } from "./ui/input";
import CountrySelector from "./country-selector";

export default function WebSearchSettings() {
  const { webSearchConfig, setWebSearchConfig } = useToolsStore();

  const handleClear = () => {
    setWebSearchConfig({
      user_location: {
        type: "approximate",
        country: "",
        region: "",
        city: "",
      },
    });
  };

  const handleLocationChange = (
    field: "country" | "region" | "city",
    value: string
  ) => {
    setWebSearchConfig({
      ...webSearchConfig,
      user_location: {
        type: "approximate",
        ...webSearchConfig.user_location,
        [field]: value,
      },
    });
  };

  const inputCls = [
    "border text-sm flex-1",
    "bg-white text-stone-900 border-stone-200 placeholder:text-stone-400",
    "dark:bg-stone-900 dark:text-stone-100 dark:border-stone-700 dark:placeholder:text-stone-500",
    "focus-visible:ring-0",
  ].join(" ");

  return (
    <div className="text-stone-900 dark:text-stone-100">
      <div className="flex items-center justify-between">
        <div className="text-stone-600 dark:text-stone-300 text-sm">
          User&apos;s location
        </div>

        <button
          type="button"
          className={[
            "text-sm font-semibold px-2 py-1 rounded-md border transition-colors",
            "border-stone-200 bg-white text-stone-900 hover:bg-stone-50",
            "dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100 dark:hover:bg-stone-800",
          ].join(" ")}
          onClick={handleClear}
        >
          Clear
        </button>
      </div>

      <div className="mt-3 space-y-3">
        <div className="flex items-center gap-2">
          <label htmlFor="country" className="text-sm w-20 text-stone-700 dark:text-stone-300">
            Country
          </label>
          <CountrySelector
            value={webSearchConfig.user_location?.country ?? ""}
            onChange={(value) => handleLocationChange("country", value)}
          />
        </div>

        <div className="flex items-center gap-2">
          <label htmlFor="region" className="text-sm w-20 text-stone-700 dark:text-stone-300">
            Region
          </label>
          <Input
            id="region"
            type="text"
            placeholder="Region"
            className={inputCls}
            value={webSearchConfig.user_location?.region ?? ""}
            onChange={(e) => handleLocationChange("region", e.target.value)}
          />
        </div>

        <div className="flex items-center gap-2">
          <label htmlFor="city" className="text-sm w-20 text-stone-700 dark:text-stone-300">
            City
          </label>
          <Input
            id="city"
            type="text"
            placeholder="City"
            className={inputCls}
            value={webSearchConfig.user_location?.city ?? ""}
            onChange={(e) => handleLocationChange("city", e.target.value)}
          />
        </div>
      </div>
    </div>
  );
}
