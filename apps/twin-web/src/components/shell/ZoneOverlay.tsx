import type { ZoneTool } from '../../state/zones';

/** Click capture for zone drawing. Vertices are committed in world coordinates
 * by the tool; the marks drawn here are the same clicks in overlay space. */
export function ZoneOverlay({ zoneTool }: { zoneTool: ZoneTool }) {
  const points = zoneTool.marks.map((mark) => `${mark.u * 100},${mark.v * 100}`).join(' ');
  return <div
    className="zone-overlay"
    onClick={(event) => {
      const bounds = event.currentTarget.getBoundingClientRect();
      zoneTool.addVertex((event.clientX - bounds.left) / bounds.width, (event.clientY - bounds.top) / bounds.height);
    }}
  >
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
      {zoneTool.marks.length > 1 && <polygon points={points} vectorEffect="non-scaling-stroke" />}
    </svg>
    {zoneTool.marks.map((mark, index) => <i key={index} style={{ left: `${mark.u * 100}%`, top: `${mark.v * 100}%` }} />)}
  </div>;
}
