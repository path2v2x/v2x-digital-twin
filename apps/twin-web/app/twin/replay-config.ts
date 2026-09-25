"use client";

import { useEffect, useState } from "react";

export const REPLAY_CONFIG_URL = "/detections/replay-config";
export const DETECTION_HISTORY_URL = "/detections/history";
export const DETECTION_COVERAGE_URL = "/detections/coverage";

/** How to fetch archived camera footage. */
export interface ArchiveAccess {
  urlTemplate: string;
  listUrlTemplate: string | null;
  offsetSeconds: number;
}

export interface ReplayConfig {
  retentionHours: number;
  historyAvailable: boolean;
  archive: ArchiveAccess | null;
  /** PROJ string of the map georeference (WGS-84 → scene frame). */
  georeference: string;
}

export function parseReplayConfig(body: unknown): ReplayConfig {
  if (!body || typeof body !== "object") throw new Error("Replay config is not an object");
  const value = body as Record<string, unknown>;
  const retentionHours = value.retention_hours;
  const offsetSeconds = value.archive_offset_seconds ?? 0;
  const urlTemplate = value.archive_url_template;
  const listUrlTemplate = value.archive_list_url_template ?? null;
  const georeference = value.georeference;
  if (typeof retentionHours !== "number" || !Number.isFinite(retentionHours) || retentionHours <= 0) throw new Error("Replay config: invalid retention_hours");
  if (typeof offsetSeconds !== "number" || !Number.isFinite(offsetSeconds)) throw new Error("Replay config: invalid archive_offset_seconds");
  if (urlTemplate !== null && typeof urlTemplate !== "string") throw new Error("Replay config: invalid archive_url_template");
  if (listUrlTemplate !== null && typeof listUrlTemplate !== "string") throw new Error("Replay config: invalid archive_list_url_template");
  if (typeof georeference !== "string" || !georeference.startsWith("+proj=")) throw new Error("Replay config: invalid georeference");
  return {
    retentionHours,
    historyAvailable: value.history_available !== false,
    archive: urlTemplate ? { urlTemplate: devSameOrigin(urlTemplate), listUrlTemplate: listUrlTemplate && devSameOrigin(listUrlTemplate), offsetSeconds } : null,
    georeference,
  };
}

/** The development server proxies the deployed host (TWIN_DEV_UPSTREAM), so absolute archive URLs become same-origin paths. */
function devSameOrigin(template: string): string {
  return process.env.NODE_ENV === "development" ? template.replace(/^https?:\/\/[^/]+/, "") : template;
}

export function useReplayConfig(): { config: ReplayConfig | null; error: string | null } {
  const [state, setState] = useState<{ config: ReplayConfig | null; error: string | null }>({ config: null, error: null });
  useEffect(() => {
    const controller = new AbortController();
    fetch(REPLAY_CONFIG_URL, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Replay config: HTTP ${response.status}`);
        setState({ config: parseReplayConfig(await response.json()), error: null });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setState({ config: null, error: error instanceof Error ? error.message : String(error) });
      });
    return () => controller.abort();
  }, []);
  return state;
}
