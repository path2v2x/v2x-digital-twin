import { useCallback, useEffect, useState } from 'react';
import { TwinScene } from './components/TwinScene';
import { Inspector } from './components/shell/Inspector';
import { TimelineDock } from './components/shell/TimelineDock';
import { Toasts } from './components/shell/Toasts';
import { ToolRail, type Armed, type ToolId } from './components/shell/ToolRail';
import { TopBar } from './components/shell/TopBar';
import { ZoneOverlay } from './components/shell/ZoneOverlay';
import { CameraCompareView } from './views/CameraCompareView';
import { DriveView } from './views/DriveView';
import { TRAJECTORY_VEHICLE, WEATHER_PRESETS } from './state/catalog';
import { useDriveSocket, useTwinSocket, type CanvasMode } from './state/twin';
import { useZones } from './state/zones';

const MODES: readonly CanvasMode[] = ['scene', 'drive', 'cameras'];

/** One editor surface. The top bar switches which canvas composition is
 * mounted; every twin operation lives in the rail, inspector or dock. */
export default function App() {
  const params = new URLSearchParams(location.search);
  const fixtureMode = params.get('fixture') === '1';
  const requestedMode = params.get('mode') as CanvasMode | null;

  const twin = useTwinSocket(fixtureMode);
  const drive = useDriveSocket(fixtureMode);
  const zoneTool = useZones(drive.sendOp);

  const [mode, setMode] = useState<CanvasMode>(requestedMode && MODES.includes(requestedMode) ? requestedMode : 'scene');
  const [tool, setTool] = useState<ToolId | null>('truth');
  const [armed, setArmed] = useState<Armed | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [weather, setWeather] = useState('clear');
  const [traffic, setTraffic] = useState('medium');
  const [acknowledged, setAcknowledged] = useState<readonly string[]>([]);

  const frame = twin.frames.at(-1);
  const actors = frame?.actors ?? [];
  const selectedActor = actors.find((actor) => actor.id === selectedId) ?? null;
  const selectedPose = frame?.scene.actors.find((actor) => actor.id === selectedId) ?? null;
  const alerts = twin.alerts.filter((alert) => !acknowledged.includes(alert.id));

  const changeMode = useCallback((next: CanvasMode) => {
    setMode(next);
    // Placement and drawing are 3D-authoring gestures: cancel them rather than
    // letting them hide behind the drive or camera canvas.
    setArmed(null);
    zoneTool.cancel();
    setTool((current) => (next === 'scene' || current === 'truth' ? current : null));
  }, [zoneTool]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (armed) setArmed(null);
      else if (zoneTool.drawing) zoneTool.cancel();
      else if (tool) setTool(null);
      else setSelectedId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [armed, tool, zoneTool]);

  const commitPlacement = useCallback(() => {
    if (!armed) return;
    drive.sendOp(armed.kind === 'scenario'
      ? { type: 'load_scenario', file: armed.entry.id }
      : { type: 'spawn_object', blueprint: armed.entry.id });
    setArmed(null);
  }, [armed, drive]);

  const seek = useCallback((second: number) => {
    twin.setMode('replay');
    twin.setClock(second);
    const start = new Date();
    start.setUTCHours(0, 0, second, 0);
    twin.send({ type: 'twin_replay', start: start.toISOString(), speed: 1 });
  }, [twin]);

  return <div className="editor">
    <TopBar
      mode={mode}
      onMode={changeMode}
      connected={twin.connected}
      fixtureMode={fixtureMode}
      clockMode={twin.mode}
      alertCount={twin.alerts.length}
      onAlerts={() => setAcknowledged([])}
    />
    <div className="editor__body">
      <ToolRail
        mode={mode}
        tool={tool}
        onTool={setTool}
        actors={actors}
        selectedId={selectedId}
        onSelect={setSelectedId}
        armed={armed}
        onArm={setArmed}
        zoneTool={zoneTool}
        onTrajectory={(file) => drive.sendOp({ type: 'start_trajectory', file, vehicle: TRAJECTORY_VEHICLE })}
      />

      <div className={`canvas${armed ? ' canvas--placing' : ''}`}>
        <div className="canvas__stage">
          {mode === 'scene' && <TwinScene frames={twin.frames} />}
          {mode === 'drive' && <DriveView frames={twin.frames} drive={drive} fixtureMode={fixtureMode} />}
          {mode === 'cameras' && <CameraCompareView frames={twin.frames} cameras={twin.cameras} />}
        </div>

        {mode === 'scene' && zoneTool.drawing && <ZoneOverlay zoneTool={zoneTool} />}
        {mode === 'scene' && armed && <div className="click-capture" onClick={commitPlacement} />}

        {armed && <div className="mode-banner">Placing {armed.entry.name}<em>click canvas to commit · esc to cancel</em></div>}
        {zoneTool.drawing && <div className="mode-banner">Drawing zone · {zoneTool.vertices.length} vertices<em>click canvas to add · save in the panel</em></div>}

        <TimelineDock
          mode={mode}
          clockMode={twin.mode}
          clock={twin.clock}
          onLive={() => { twin.setMode('live'); twin.send({ type: 'twin_live' }); }}
          onSeek={seek}
        />
        <Toasts alerts={alerts} onDismiss={(id) => setAcknowledged((current) => [...current, id])} />
      </div>

      {(mode === 'scene' || selectedActor) && <Inspector
        actor={selectedActor}
        sceneActor={selectedPose}
        onClose={() => setSelectedId(null)}
        weather={weather}
        onWeather={(preset) => { setWeather(preset); drive.sendOp({ type: 'set_weather', params: WEATHER_PRESETS[preset] ?? WEATHER_PRESETS['clear'] }); }}
        traffic={traffic}
        onTraffic={(preset) => { setTraffic(preset); drive.sendOp({ type: 'spawn_traffic', preset }); }}
      />}
    </div>
  </div>;
}
