import type { ScenarioMapEntry } from "@simforge-oss/editor";

/**
 * A map descriptor as the list needs it: enough to title a group and paint its card.
 *
 * `thumbnailUrl` resolves `map_versions.thumbnail_artifact_id` through a stable Scenario route.
 * The browser never reads the source map-assets bucket or guesses a storage key.
 */
export type ScenarioMapOption = {
  mapVersionId: string;
  /** Canonical compiler-facing identity, distinct from the immutable version id. */
  sourceMapId: string;
  label: string;
  locality?: string | null;
  thumbnailUrl?: string | null;
  /**
   * The renderer entry point for this map, and the one URL here that is safe to hold.
   *
   * Unlike `thumbnailUrl` and the descriptor's manifest/topology URLs, this is not presigned — it is a
   * path on our own `browser-assets` proxy, so it has no expiry to outlive. That is exactly why the
   * scene preloader keys its cache on it (§2.5.3 forbids caching the presigned ones).
   */
  browserManifestUrl?: string | null;
  topologyUrl?: string | null;
  derivedTopologyUrl?: string | null;
  locationsUrl?: string | null;
  signalsUrl?: string | null;
} & Partial<
  Pick<
    ScenarioMapEntry,
    | "id"
    | "versionId"
    | "sourceMapId"
    | "browserAssetRootUrl"
    | "browserClosureSha256"
    | "artifacts"
    | "sumoNetworkSha256"
    | "manifestUrl"
  >
>;
