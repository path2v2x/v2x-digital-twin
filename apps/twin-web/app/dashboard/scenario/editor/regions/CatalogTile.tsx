"use client";

import type { CSSProperties, DragEvent } from "react";
import type { CatalogEntry, CatalogId, PropClass } from "@simforge-oss/asset-catalog";

import { DynamicActorCatalogIcon, type DynamicActorCatalogId } from "./DynamicActorCatalogIcon";
import { ObjectCatalogIcon } from "./ObjectCatalogIcon";
import { PedestrianCatalogIcon, type PedestrianCatalogId } from "./PedestrianCatalogIcon";
import { VehicleCatalogIcon, type VehicleCatalogId } from "./VehicleCatalogIcon";

/** One model, one tile: icon, name, footprint. Nothing else, so a wall of models stays scannable. */
export function CatalogTile({
  entry,
  favorite,
  active,
  stagger,
  onChoose,
  onFavorite,
  onDragStart,
  onDragEnd,
}: {
  entry: CatalogEntry;
  favorite: boolean;
  active: boolean;
  /** Entrance delay in ms, so a category deals itself out instead of blinking in. */
  stagger: number;
  onChoose: () => void;
  onFavorite: () => void;
  onDragStart: (event: DragEvent) => void;
  onDragEnd: () => void;
}) {
  const icon = catalogArt(entry);
  return (
    <div
      className="actor-catalog-tile actor-catalog-tile-enter"
      data-active={String(active)}
      title={entry.description}
      data-testid={`catalog-${entry.id}`}
      style={{ ...styles.tile, animationDelay: `${stagger}ms` }}
    >
      <div
        draggable
        role="button"
        tabIndex={0}
        aria-label={`Place ${entry.label}`}
        data-testid={`catalog-action-${entry.id}`}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onClick={onChoose}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onChoose();
          }
        }}
        style={styles.tileAction}
      >
        <span className="actor-catalog-tile-icon" style={{ ...styles.tileIcon, color: classColor(entry.class) }}>{icon}</span>
        <strong style={styles.tileLabel}>{entry.label}</strong>
        <span style={styles.tileMeta}>{entry.dims.l.toFixed(1)} × {entry.dims.w.toFixed(1)} m</span>
      </div>
      <button
        type="button"
        aria-label={`${favorite ? "Remove" : "Add"} ${entry.label} ${favorite ? "from" : "to"} favorites`}
        aria-pressed={favorite}
        style={{ ...styles.favorite, ...(favorite ? styles.favoriteActive : null) }}
        onClick={(event) => { event.stopPropagation(); onFavorite(); }}
      >
        {favorite ? "★" : "☆"}
      </button>
    </div>
  );
}

/** Artwork for one catalog entry. */
function catalogArt(entry: CatalogEntry) {
  if (entry.class === "vehicle") return <VehicleCatalogIcon id={entry.id as VehicleCatalogId} />;
  if (entry.class === "pedestrian") return <PedestrianCatalogIcon id={entry.id as PedestrianCatalogId} />;
  if (entry.class === "sidewalk_robot" || entry.class === "drone" || entry.class === "animal") {
    return <DynamicActorCatalogIcon id={entry.id as DynamicActorCatalogId} />;
  }
  return <ObjectCatalogIcon id={entry.id as CatalogId} />;
}

function classColor(kind: PropClass): string { if (kind === "vehicle") return "#68a5ff"; if (kind === "pedestrian") return "#f2b35f"; if (kind === 'sidewalk_robot') return '#73d5ff'; if (kind === 'drone') return '#9ea7ff'; if (kind === 'animal') return '#d7ae76'; if (kind === "construction") return "#ff9250"; if (kind === "street") return "#72c4ae"; if (kind === "occluder") return "#a68de7"; return "#e06767"; }

const styles: Record<string, CSSProperties> = {
  tile: { position: "relative", minWidth: 0, display: "flex", padding: 0, boxSizing: "border-box", color: "#d8dce2", userSelect: "none" },
  tileAction: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 1, padding: "9px 9px 8px", cursor: "grab", outline: "none" },
  tileIcon: { width: 50, height: 32, marginBottom: 3, display: "grid", placeItems: "center" },
  tileLabel: { maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 10.5, fontWeight: 620, color: "#eef1f6" },
  tileMeta: { color: "#737c89", fontSize: 8.5, fontVariantNumeric: "tabular-nums" },
  favorite: { position: "absolute", right: 4, bottom: 3, width: 20, height: 20, padding: 0, border: 0, background: "transparent", color: "#69717d", cursor: "pointer", fontSize: 13, lineHeight: 1 },
  favoriteActive: { color: "#f1b74f" },
};
