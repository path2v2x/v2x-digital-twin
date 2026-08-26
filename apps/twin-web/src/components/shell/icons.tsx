/** Line icons for the editor chrome. 24-unit grid, 1.5 stroke, currentColor;
 * sizing comes from the consuming class (.icon-btn svg / .seg__item svg). */
/* Intrinsic 16px so an icon dropped into a flex row without a sizing rule
 * cannot stretch to the container's width; CSS still overrides per component. */
const BASE = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };

/** The SimForge mark. Filled rather than stroked: it is a logotype, not an
 * icon, and the top bar scales it to 30px where a 1.5 stroke would thin out. */
export const LogoMark = ({ size = 30 }: { size?: number }) => <svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  strokeWidth={2.4}
  strokeLinecap="round"
  strokeLinejoin="round"
  aria-hidden
><path d="M18.5 5.5A6.6 6.6 0 0 0 8 6.4c-1 2.3.4 4.3 3.2 5.1 3.4 1 5.2 2.9 4.2 5.4a6.6 6.6 0 0 1-10.7 1.6" /></svg>;

export const SceneIcon = () => <svg {...BASE}><path d="M12 3 21 7.5v9L12 21 3 16.5v-9L12 3Z" /><path d="M3 7.5 12 12l9-4.5M12 12v9" /></svg>;
export const DriveIcon = () => <svg {...BASE}><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="3" /><path d="M12 3v6M4.2 16.5 9.4 13.5M19.8 16.5 14.6 13.5" /></svg>;
export const CameraIcon = () => <svg {...BASE}><path d="M3 8h4l1.5-2h7L17 8h4v11H3V8Z" /><circle cx="12" cy="13" r="3.2" /></svg>;
export const ListIcon = () => <svg {...BASE}><path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" /></svg>;
export const ScenarioIcon = () => <svg {...BASE}><path d="M5 21V4M5 4h10l-1.5 3.5L15 11H5" /><path d="M15 11h4v7h-8" /></svg>;
export const VehicleIcon = () => <svg {...BASE}><path d="M3 14.5 4.8 9h14.4L21 14.5v3.5h-2M5 18H3v-3.5M3 14.5h18" /><circle cx="7.5" cy="18" r="1.8" /><circle cx="16.5" cy="18" r="1.8" /></svg>;
export const ZoneIcon = () => <svg {...BASE}><path d="M6 5 19 8l-2 11L5 17 6 5Z" /><path d="M6 5h.01M19 8h.01M17 19h.01M5 17h.01" /></svg>;
export const TrajectoryIcon = () => <svg {...BASE}><path d="M5 19c6 0 3-7 8-7s3 5 6 5" /><circle cx="4.5" cy="19" r="1.6" /><circle cx="19.5" cy="17" r="1.6" /></svg>;
export const WeatherIcon = () => <svg {...BASE}><path d="M7 16.5a3.8 3.8 0 0 1 .5-7.6 5.2 5.2 0 0 1 10 1.2 3.4 3.4 0 0 1-.6 6.4H7Z" /><path d="M9 20l-.8 1.5M13 20l-.8 1.5M17 20l-.8 1.5" /></svg>;
export const TrafficIcon = () => <svg {...BASE}><rect x="8" y="3" width="8" height="18" rx="0" /><circle cx="12" cy="7.5" r="1.3" /><circle cx="12" cy="12" r="1.3" /><circle cx="12" cy="16.5" r="1.3" /></svg>;
export const CloseIcon = () => <svg {...BASE}><path d="M6 6l12 12M18 6 6 18" /></svg>;
export const SearchIcon = () => <svg {...BASE}><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4.5 4.5" /></svg>;
export const LiveIcon = () => <svg {...BASE}><circle cx="12" cy="12" r="3" /><path d="M6.5 6.5a7.8 7.8 0 0 0 0 11M17.5 6.5a7.8 7.8 0 0 1 0 11M3.5 3.5a12 12 0 0 0 0 17M20.5 3.5a12 12 0 0 1 0 17" /></svg>;
export const ReplayIcon = () => <svg {...BASE}><path d="M4 12a8 8 0 1 0 3.2-6.4M4 5v4h4" /></svg>;
export const AlertIcon = () => <svg {...BASE}><path d="M12 4.5 21 19H3L12 4.5Z" /><path d="M12 10v4M12 16.5h.01" /></svg>;
export const CheckIcon = () => <svg {...BASE}><circle cx="12" cy="12" r="8.5" /><path d="m8.5 12 2.4 2.4 4.6-4.8" /></svg>;
export const TargetIcon = () => <svg {...BASE}><circle cx="12" cy="12" r="7" /><circle cx="12" cy="12" r="2" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></svg>;
export const SettingsIcon = () => <svg {...BASE}><circle cx="12" cy="12" r="3" /><path d="M12 2.8v2.4M12 18.8v2.4M4.5 7.5l2 1.2M17.5 15.3l2 1.2M4.5 16.5l2-1.2M17.5 8.7l2-1.2" /></svg>;
