"use client";

import { useEffect, useState } from "react";

import type { ArchiveAccess } from "./archive";

export const REPLAY_CONFIG_URL = "/detections/replay-config";
export const DETECTION_EVENTS_URL = "/detections/events";

export function parseArchiveAccess(body: unknown): ArchiveAccess | null {
  if (!body || typeof body !== "object") throw new Error("Replay config is not an object");
  const value = body as Record<string, unknown>;
  const urlTemplate = value.archive_url_template ?? null;
  const listUrlTemplate = value.archive_list_url_template ?? null;
  const offsetSeconds = value.archive_offset_seconds ?? 0;
  if (urlTemplate !== null && typeof urlTemplate !== "string") throw new Error("Replay config: invalid archive_url_template");
  if (listUrlTemplate !== null && typeof listUrlTemplate !== "string") throw new Error("Replay config: invalid archive_list_url_template");
  if (typeof offsetSeconds !== "number" || !Number.isFinite(offsetSeconds)) throw new Error("Replay config: invalid archive_offset_seconds");
  if (!urlTemplate) return null;
  return { urlTemplate: devSameOrigin(urlTemplate), listUrlTemplate: listUrlTemplate && devSameOrigin(listUrlTemplate), offsetSeconds };
}

/** The development server proxies the deployed host (TWIN_DEV_UPSTREAM), so absolute archive URLs become same-origin paths. */
function devSameOrigin(template: string): string {
  return process.env.NODE_ENV === "development" ? template.replace(/^https?:\/\/[^/]+/, "") : template;
}

/** Archive access advertised by the twin server; `access` stays null while loading or when no archive is configured. */
export function useArchiveAccess(): { access: ArchiveAccess | null; loaded: boolean; error: string | null } {
  const [state, setState] = useState<{ access: ArchiveAccess | null; loaded: boolean; error: string | null }>({ access: null, loaded: false, error: null });
  useEffect(() => {
    const controller = new AbortController();
    fetch(REPLAY_CONFIG_URL, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        setState({ access: parseArchiveAccess(await response.json()), loaded: true, error: null });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setState({ access: null, loaded: true, error: error instanceof Error ? error.message : String(error) });
      });
    return () => controller.abort();
  }, []);
  return state;
}
