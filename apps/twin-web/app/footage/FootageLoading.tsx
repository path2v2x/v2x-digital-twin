"use client";

import { LoaderCircle } from "lucide-react";

import { cn } from "@/app/lib/utils";

/**
 * Over a footage video while the instant it should show has not loaded (a jump,
 * or playback that caught up with the loaded footage). It fades in after 300 ms,
 * so footage that loads at once never flashes it. `compact` drops the label for
 * thumbnail-sized videos.
 */
export function FootageLoading({ compact = false }: { compact?: boolean }) {
  return (
    <div
      role="status"
      className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/30 animate-in fade-in fill-mode-both delay-300 duration-200"
      data-testid="footage-loading"
    >
      <span className={cn("flex items-center justify-center bg-black/60 backdrop-blur-sm", compact ? "size-8" : "size-12")}>
        <LoaderCircle aria-hidden="true" className={cn("text-white motion-safe:animate-spin", compact ? "size-4" : "size-6")} />
      </span>
      <span className={cn("text-sm font-medium text-white drop-shadow", compact && "sr-only")}>Loading footage</span>
    </div>
  );
}
