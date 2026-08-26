import { useState } from 'react';
import { CloseIcon, ListIcon, ScenarioIcon, SearchIcon, TrafficIcon, TrajectoryIcon, VehicleIcon, WeatherIcon, ZoneIcon } from './icons';
import { PROPS, SCENARIOS, TRAJECTORIES, VEHICLES, type CatalogEntry } from '../../state/catalog';
import type { CanvasMode } from '../../state/twin';
import type { ZoneTool } from '../../state/zones';
import type { TruthActor } from '../../lib/truth';

export type ToolId = 'truth' | 'scenarios' | 'vehicles' | 'zones' | 'trajectories';
/** The two world controls. They open the inspector rather than a left panel:
 * weather and traffic edit the scene you are looking at, not a library. */
export type WorldTool = 'weather' | 'traffic';

/** What a canvas click will commit while a library entry is armed. */
export interface Armed { tool: ToolId; kind: 'scenario' | 'blueprint'; entry: CatalogEntry }

interface ToolDef {
  id: ToolId;
  label: string;
  sub: string;
  Icon: () => React.JSX.Element;
  PanelIcon?: () => React.JSX.Element;
  group: number;
}

/* Groups, not a run of glyphs: what is out there, then what you add, then
 * how you route it. The gap plus a hairline is the whole separation — a
 * labelled header does not fit 48px and the tooltip already names each one. */
const TOOLS: readonly ToolDef[] = [
  { id: 'truth', label: 'Search truth objects', sub: 'Every actor in the current truth frame. Selecting a row opens its detail in the inspector.', Icon: SearchIcon, PanelIcon: ListIcon, group: 0 },
  { id: 'scenarios', label: 'Scenarios', sub: 'Authored templates. Arm one, then click the canvas to commit it at its authored pose.', Icon: ScenarioIcon, group: 1 },
  { id: 'vehicles', label: 'Vehicles and props', sub: 'Arm a blueprint, then click the canvas. The server places it 8 m ahead of the session vehicle.', Icon: VehicleIcon, group: 1 },
  { id: 'zones', label: 'V2X zones', sub: 'Draw an advisory polygon on the canvas. Saved zones sync to the server and persist locally.', Icon: ZoneIcon, group: 2 },
  { id: 'trajectories', label: 'Trajectories', sub: 'Recorded GPS tracks. Playback drives a vehicle along the recorded path.', Icon: TrajectoryIcon, group: 2 },
];

const WORLD_TOOLS: readonly { id: WorldTool; label: string; Icon: () => React.JSX.Element }[] = [
  { id: 'weather', label: 'Weather', Icon: WeatherIcon },
  { id: 'traffic', label: 'Ambient traffic', Icon: TrafficIcon },
];

/** Placement and drawing are only meaningful on the interactive 3D canvas. */
const SCENE_ONLY: readonly ToolId[] = ['scenarios', 'vehicles', 'zones', 'trajectories'];

interface ToolRailProps {
  mode: CanvasMode;
  tool: ToolId | null;
  onTool(tool: ToolId | null): void;
  world: WorldTool | null;
  onWorld(world: WorldTool | null): void;
  actors: readonly TruthActor[];
  selectedId: string | null;
  onSelect(id: string): void;
  armed: Armed | null;
  onArm(armed: Armed | null): void;
  zoneTool: ZoneTool;
  onTrajectory(file: string): void;
}

export function ToolRail(props: ToolRailProps) {
  /* The glass slab clips its own overflow, so the tooltip cannot be a child of
   * the hovered button — it is positioned in the viewport against the button's
   * measured centre instead. */
  const [tip, setTip] = useState<{ label: string; top: number } | null>(null);
  const available = TOOLS.filter((entry) => props.mode === 'scene' || !SCENE_ONLY.includes(entry.id));
  const open = available.find((entry) => entry.id === props.tool);
  const groups = [0, 1, 2].map((group) => available.filter((entry) => entry.group === group)).filter((tools) => tools.length > 0);

  const hover = (label: string) => (event: React.SyntheticEvent<HTMLElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    setTip({ label, top: box.top + box.height / 2 });
  };

  return <>
    <nav className="rail" aria-label="Authoring tools" onMouseLeave={() => setTip(null)}>
      <div className="rail__glass" data-testid="twin-tool-rail">
        {groups.map((tools, index) => <div className="rail__group" key={tools[0].id}>
          {index > 0 && <span className="rail__rule" aria-hidden />}
          {tools.map(({ id, label, Icon }) => <button
            key={id}
            type="button"
            className="rail__btn"
            aria-pressed={props.tool === id}
            aria-label={label}
            data-testid={`tool-${id}`}
            onMouseEnter={hover(label)}
            onFocus={hover(label)}
            onBlur={() => setTip(null)}
            onClick={() => props.onTool(props.tool === id ? null : id)}
          ><Icon /></button>)}
        </div>)}

        <div className="rail__group">
          <span className="rail__rule" aria-hidden />
          {WORLD_TOOLS.map(({ id, label, Icon }) => <button
            key={id}
            type="button"
            className="rail__btn"
            aria-pressed={props.world === id}
            aria-label={label}
            data-testid={`tool-${id}`}
            onMouseEnter={hover(label)}
            onFocus={hover(label)}
            onBlur={() => setTip(null)}
            onClick={() => props.onWorld(props.world === id ? null : id)}
          ><Icon /></button>)}
        </div>
      </div>
      {tip && <span className="rail__tip" role="tooltip" style={{ top: tip.top }}>{tip.label}</span>}
    </nav>
    {open && <ToolPanel key={open.id} {...props} definition={open} />}
  </>;
}

interface ToolPanelProps extends ToolRailProps {
  definition: ToolDef;
}

/** Opened by the rail, unmounted by Escape or the close button. Nothing in the
 * twin keeps a library pinned open behind the canvas. */
function ToolPanel({ definition, mode, onTool, actors, selectedId, onSelect, armed, onArm, zoneTool, onTrajectory }: ToolPanelProps) {
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const searchable = definition.id === 'truth' || definition.id === 'vehicles';
  const Glyph = definition.PanelIcon ?? definition.Icon;

  return <section className="panel panel--left" aria-label={definition.label} data-testid={`panel-${definition.id}`}>
    <header className="panel__head">
      <span className="panel__icon" aria-hidden><Glyph /></span>
      <span>
        <span className="panel__title">{definition.label}</span>
        <span className="panel__sub">{definition.id}</span>
      </span>
      <button type="button" className="icon-btn panel__close" aria-label="Close panel" onClick={() => onTool(null)}><CloseIcon /></button>
    </header>

    <div className="panel__body scroll">
      <p className="card__body" style={{ marginBottom: 'var(--s-3)' }}>{definition.sub}</p>

      {searchable && <input
        className="input"
        type="search"
        placeholder={definition.id === 'truth' ? 'Search cars, pedestrians, ids…' : 'Search vehicles and props…'}
        aria-label={`Filter ${definition.label}`}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        /* Never steal the drive keys: autofocus only where typing is the intent. */
        autoFocus={mode === 'scene'}
      />}

      {definition.id === 'truth' && <TruthList actors={actors} needle={needle} selectedId={selectedId} onSelect={onSelect} />}

      {definition.id === 'scenarios' && <div className="tile-grid" style={{ marginTop: 'var(--s-2)' }}>
        {SCENARIOS.map((entry) => <Tile key={entry.id} entry={entry} armed={armed?.entry.id === entry.id} onClick={() => onArm(armed?.entry.id === entry.id ? null : { tool: 'scenarios', kind: 'scenario', entry })} />)}
      </div>}

      {definition.id === 'vehicles' && <>
        <BlueprintGroup title="Vehicles" entries={VEHICLES} needle={needle} armed={armed} onArm={onArm} />
        <BlueprintGroup title="Props" entries={PROPS} needle={needle} armed={armed} onArm={onArm} />
      </>}

      {definition.id === 'zones' && <ZonePanel zoneTool={zoneTool} />}

      {definition.id === 'trajectories' && TRAJECTORIES.map((entry) => <div className="row" key={entry.id}>
        <span className="row__label">{entry.name}</span>
        <span className="row__meta">{entry.detail}</span>
        <button type="button" className="btn btn--sm btn--outline" onClick={() => onTrajectory(entry.id)}>Play</button>
      </div>)}
    </div>

    <footer className="panel__foot">
      <span className="meta">
        {definition.id === 'truth' && `${actors.length} objects in frame`}
        {definition.id === 'scenarios' && 'Arm a template, then click the canvas'}
        {definition.id === 'vehicles' && 'Arm a blueprint, then click the canvas'}
        {definition.id === 'zones' && `${zoneTool.zones.length} zones synced`}
        {definition.id === 'trajectories' && 'Playback needs a live session'}
      </span>
    </footer>
  </section>;
}

function TruthList({ actors, needle, selectedId, onSelect }: { actors: readonly TruthActor[]; needle: string; selectedId: string | null; onSelect(id: string): void }) {
  const matches = actors.filter((actor) => !needle || actor.id.toLowerCase().includes(needle) || actor.class.includes(needle));
  if (!matches.length) return <div className="empty">
    <span className="empty__title">{actors.length ? 'Nothing matches that' : 'Waiting on the truth stream'}</span>
    <span className="empty__text">{actors.length
      ? 'Clear the filter to see all objects in the current frame.'
      : 'The first frame with actors will populate this list. Check the connection pill if it stays empty.'}</span>
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
    <span className="meta">{armed ? 'Armed · click canvas' : entry.detail}</span>
  </button>;
}

function ZonePanel({ zoneTool }: { zoneTool: ZoneTool }) {
  return <>
    <div className="card__foot">
      {zoneTool.drawing
        ? <>
          <button type="button" className="btn btn--primary" disabled={zoneTool.vertices.length < 3} onClick={zoneTool.save}>Save polygon ({zoneTool.vertices.length})</button>
          <button type="button" className="btn btn--outline" onClick={zoneTool.cancel}>Cancel</button>
        </>
        : <button type="button" className="btn btn--primary" onClick={zoneTool.start}>Draw zone</button>}
    </div>
    {zoneTool.drawing && <div className="hint"><span className="hint__dot" aria-hidden />Click the canvas to drop vertices. Three minimum, then save.</div>}
    <div className="section-head">Saved zones<span className="section-head__count">{zoneTool.zones.length}</span></div>
    {zoneTool.zones.length === 0
      ? <div className="empty">
        <span className="empty__title">No advisory zones yet</span>
        <span className="empty__text">Draw a polygon on the canvas. The server evaluates ego entry every tick and the shape persists locally.</span>
      </div>
      : zoneTool.zones.map((zone) => <div className="row" key={zone.id}>
        <span className="row__label">{zone.name}</span>
        <span className="row__meta">{zone.polygon.length} pts</span>
        <button type="button" className="icon-btn icon-btn--sm" aria-label={`Delete ${zone.name}`} onClick={() => zoneTool.remove(zone.id)}><CloseIcon /></button>
      </div>)}
  </>;
}
