"use client";

import type { ReactNode } from "react";
import { House } from "lucide-react";

import { useTopBarSlotContext } from "@/app/components/TopBarSlot";

/** Single app bar: brand, twin time, then editor and drive actions. */
export function TwinTopBar({ timeBar }: { timeBar: ReactNode }) {
  const slots = useTopBarSlotContext();
  const homeUrl = process.env.NEXT_PUBLIC_TWIN_HOME_URL?.trim() || null;
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-background px-3" data-testid="twin-top-bar">
      <div className="flex shrink-0 items-center gap-2">
        <span aria-hidden="true" className="grid size-6 place-items-center bg-primary text-[10px] font-bold text-primary-foreground">V2X</span>
        <span className="hidden text-sm font-semibold tracking-tight text-foreground lg:inline">Digital Twin</span>
      </div>
      <div className="flex min-w-0 max-w-[760px] flex-1 items-center">{timeBar}</div>
      <div ref={slots?.registerActionsSlot} className="flex min-w-0 items-center gap-2" />
      <div ref={slots?.registerTrailingSlot} className="ml-auto flex shrink-0 items-center gap-2" />
      {homeUrl ? (
        <a href={homeUrl} className="flex h-8 shrink-0 items-center gap-1.5 border border-border px-2.5 text-xs text-muted-foreground hover:text-foreground">
          <House aria-hidden="true" className="size-3.5" /> Home
        </a>
      ) : null}
    </header>
  );
}
