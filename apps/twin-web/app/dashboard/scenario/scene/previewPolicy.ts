import type { ResolvedAmbientTrafficProfile } from "@simforge-oss/engine";
import {
  ambientTrafficProfileFromExtensions,
  ambientTrafficProviderFromExtensions,
} from "@simforge-oss/playback/traffic";
import type { ScenarioMapEntry } from "@simforge-oss/editor";
import type { ScenarioMapOption } from "../list/document-map-groups";

export type EngineTrafficProvider = "off" | "native";

/** Playback compilation needs this complete immutable map-sidecar closure. */
export function mapSupportsScenarioPreview(
  map: ScenarioMapOption,
): map is ScenarioMapOption & ScenarioMapEntry {
  return Boolean(
    map.browserManifestUrl
      && map.topologyUrl
      && map.derivedTopologyUrl
      && map.locationsUrl
      && map.id === map.mapVersionId
      && map.versionId === map.mapVersionId
      && map.sourceMapId
      && map.browserAssetRootUrl
      && map.browserClosureSha256
      && map.artifacts
      && map.sumoNetworkSha256 !== undefined,
  );
}

/** Any saved non-off provider, including legacy external-provider choices, runs native engine traffic. */
export function engineTrafficProviderFromExtensions(
  extensions: Readonly<Record<string, unknown>> | undefined,
): EngineTrafficProvider {
  return ambientTrafficProviderFromExtensions(extensions) === "off" ? "off" : "native";
}

export function previewAmbientTrafficProfile(
  extensions: Readonly<Record<string, unknown>> | undefined,
): ResolvedAmbientTrafficProfile {
  return engineTrafficProviderFromExtensions(extensions) === "native"
    ? ambientTrafficProfileFromExtensions(extensions)
    : ambientTrafficProfileFromExtensions({
        "studio.ambientTraffic.profile.v1": {
          version: 1,
          preset: "off",
          seed: "execution-provider-off",
        },
      });
}
