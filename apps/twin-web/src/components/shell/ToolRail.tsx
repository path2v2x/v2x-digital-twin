import { useState } from 'react';
import { CloseIcon, ListIcon, ScenarioIcon, TrajectoryIcon, VehicleIcon, ZoneIcon } from './icons';
import { PROPS, SCENARIOS, TRAJECTORIES, VEHICLES, type CatalogEntry } from '../../state/catalog';
import type { CanvasMode } from '../../state/twin';
import type { ZoneTool } from '../../state/zones';
import type { TruthActor } from '../../lib/truth';

export type ToolId = 'truth' | 'scenarios' | 'vehicles' | 'zones' | 'trajectories';

/** What a canvas click will commit while a library entry is armed. */
export interface Armed { tool: ToolId; kind: 'scenario' | 'blueprint'; entry: CatalogEntry }

const TOOLS: readonly { id: ToolId; label: string; sub: string; Icon: () => React.JSX.Element; group: number }[] = [
  { id: 'truth', label: 'Truth objects', sub: 'Every actor in the current truth frame. Selecting a row opens its detail in the inspector.', Icon: ListIcon, group: 0 },
  { id: 'scenarios', label: 'Scenarios', sub: 'Authored templates. Arm one, then click the canvas to commit it at its authored pose.', Icon: ScenarioIcon, group: 1 },
  { id: 'vehicles', label: 'Vehicles and props', sub: 'Arm a blueprint, then click the canvas. The server places it 8 m ahead of the session vehicle.', Icon: VehicleIcon, group: 1 },
  { id: 'zones', label: 'V2X zones', sub: 'Draw an advisory polygon on the canvas. Saved zones sync to the server and persist locally.', Icon: ZoneIcon, group: 2 },
  { id: 'trajectories', label: 'Trajectories', sub: 'Recorded GPS tracks. Playback drives a vehicle along the recorded path.', Icon: TrajectoryIcon, group: 2 },
];

/** Placement and drawing are only meaningful on the interactive 3D canvas. */
const SCENE_ONLY: readonly ToolId[] = ['scenarios', 'vehicles', 'zones', 'trajectories'];

interface ToolRailProps {
  mode: CanvasMode;
  tool: ToolId | null;
  onTool(tool: ToolId | null): void;
  actors: readonly TruthActor[];
  selectedId: string | null;
  onSelect(id: string): void;
  armed: Armed | null;
  onArm(armed: Armed | null): void;
  zoneTool: ZoneTool;
  onTrajectory(file: string): void;
}

export function ToolRail(props: ToolRailProps) {
  const available = TOOLS.filter((entry) => props.mode === 'scene' || !SCENE_ONLY.includes(entry.id));
  const open = available.find((entry) => entry.id === props.tool);
  return <>
    <nav className="rail" aria-label="Twin library">
      {[0, 1, 2].map((group) => {
        const tools = available.filter((entry) => entry.group === group);
        if (!tools.length) return null;
        return <div className="rail__group" key={group}>
          {tools.map(({ id, label, Icon }) => <span className="tip-host" key={id}>
            <button
              type="button"
              className="icon-btn rail__tool"
              aria-pressed={props.tool === id}
              aria-label={label}
              onClick={() => props.onTool(props.tool === id ? null : id)}
            ><Icon /></button>
            <span className="tip" role="tooltip">{label}</span>
          </span>)}
        </div>;
      })}
    </nav>
    {open && <Library key={open.id} {...props} definition={open} />}
  </>;
}

interface LibraryProps extends ToolRailProps {
  definition: { id: ToolId; label: string; sub: string };
}

function Library({ definition, mode, onTool, actors, selectedId, onSelect, armed, onArm, zoneTool, onTrajectory }: LibraryProps) {
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const searchable = definition.id === 'truth' || definition.id === 'vehicles';

  return <section className="library" aria-label={definition.label}>
    <header className="library__head">
      <span className="library__title">
        <strong>{definition.label}</strong>
        <span className="library__sub">{definition.sub}</span>
      </span>
      <button type="button" className="icon-btn icon-btn--sm" aria-label="Close panel" onClick={() => onTool(null)}><CloseIcon /></button>
    </header>

    {searchable && <div className="library__controls">
      <input
        className="input"
        type="search"
        placeholder="Filter"
        aria-label={`Filter ${definition.label}`}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        /* Never steal the drive keys: autofocus only where typing is the intent. */
        autoFocus={mode === 'scene'}
      />
    </div>}

    <div className="library__body scroll">
      {definition.id === 'truth' && <TruthList actors={actors} needle={needle} selectedId={selectedId} onSelect={onSelect} />}

      {definition.id === 'scenarios' && <div className="tile-grid">
        {SCENARIOS.map((entry) => <Tile key={entry.id} entry={entry} armed={armed?.entry.id === entry.id} onClick={() => onArm(armed?.entry.id === entry.id ? null : { tool: 'scenarios', kind: 'scenario', entry })} />)}
      </div>}

      {definition.id === 'vehicles' && <>
        <BlueprintGroup title="Vehicles" entries={VEHICLES} needle={needle} armed={armed} onArm={onArm} />
        <BlueprintGroup title="Props" entries={PROPS} needle={needle} armed={armed} onArm={onArm} />
      </>}

      {definition.id === 'zones' && <ZonePanel zoneTool={zoneTool} />}

      {definition.id === 'trajectories' && <>
        {TRAJECTORIES.map((entry) => <div className="row" key={entry.id}>
          <span className="row__label">{entry.name}</span>
          <span className="row__meta">{entry.detail}</span>
          <button type="button" className="btn btn--sm" onClick={() => onTrajectory(entry.id)}>Play</button>
        </div>)}
      </>}
    </div>

    <footer className="library__foot">
      {definition.id === 'truth' && `${actors.length} objects in frame`}
      {definition.id === 'scenarios' && 'Arm a template, then click the canvas to commit'}
      {definition.id === 'vehicles' && 'Arm a blueprint, then click the canvas to commit'}
      {definition.id === 'zones' && `${zoneTool.zones.length} zones synced`}
      {definition.id === 'trajectories' && 'Playback needs a live session; one starts automatically'}
    </footer>
  </section>;
}

function TruthList({ actors, needle, selectedId, onSelect }: { actors: readonly TruthActor[]; needle: string; selectedId: string | null; onSelect(id: string): void }) {
  const matches = actors.filter((actor) => !needle || actor.id.toLowerCase().includes(needle) || actor.class.includes(needle));
  if (!matches.length) return <div className="empty">
    <span className="empty__title">No objects</span>
    <span className="empty__text">{actors.length ? 'No truth object matches this filter.' : 'The truth stream has not delivered a frame with actors yet.'}</span>
  </div>;
  return <>{matches.map((actor) => <button
    key={actor.id}
    type="button"
    className={`row${selectedId === actor.id ? ' is-selected' : ''}`}
    onClick={() => onSelect(actor.id)}
  >
    <span className="row__label">{actor.id}</span>
    <span className="row__meta">{actor.class}</span>
  </button>)}</>;
}

function BlueprintGroup({ title, entries, needle, armed, onArm }: { title: string; entries: readonly CatalogEntry[]; needle: string; armed: Armed | null; onArm(armed: Armed | null): void }) {
  const matches = entries.filter((entry) => !needle || entry.name.toLowerCase().includes(needle) || entry.id.includes(needle));
  if (!matches.length) return null;
  return <>
    <div className="section-head">{title}<span className="section-head__count">{matches.length}</span></div>
    <div className="tile-grid">
      {matches.map((entry) => <Tile
        key={entry.id}
        entry={entry}
        armed={armed?.entry.id === entry.id}
        onClick={() => onArm(armed?.entry.id === entry.id ? null : { tool: 'vehicles', kind: 'blueprint', entry })}
      />)}
    </div>
  </>;
}

function Tile({ entry, armed, onClick }: { entry: CatalogEntry; armed: boolean; onClick(): void }) {
  return <button type="button" className={`tile${armed ? ' is-armed' : ''}`} aria-pressed={armed} onClick={onClick}>
    <strong>{entry.name}</strong>
    <span>{armed ? 'Armed · click canvas' : entry.detail}</span>
  </button>;
}

function ZonePanel({ zoneTool }: { zoneTool: ZoneTool }) {
  return <>
    <div className="library__controls">
      {zoneTool.drawing
        ? <>
          <button type="button" className="btn btn--primary" disabled={zoneTool.vertices.length < 3} onClick={zoneTool.save}>Save polygon ({zoneTool.vertices.length})</button>
          <button type="button" className="btn" onClick={zoneTool.cancel}>Cancel</button>
        </>
        : <button type="button" className="btn btn--primary" onClick={zoneTool.start}>Draw zone</button>}
    </div>
    <div className="section-head">Saved zones<span className="section-head__count">{zoneTool.zones.length}</span></div>
    {zoneTool.zones.length === 0
      ? <div className="empty">
        <span className="empty__title">No zones</span>
        <span className="empty__text">Draw an advisory polygon on the canvas. Three vertices minimum; the server evaluates ego entry every tick.</span>
      </div>
      : zoneTool.zones.map((zone) => <div className="row" key={zone.id}>
        <span className="row__label">{zone.name}</span>
        <span className="row__meta">{zone.polygon.length} pts</span>
        <button type="button" className="icon-btn icon-btn--sm" aria-label={`Delete ${zone.name}`} onClick={() => zoneTool.remove(zone.id)}><CloseIcon /></button>
      </div>)}
  </>;
}
