import { AlertIcon, CloseIcon } from './icons';
import type { Alert } from '../../state/twin';

/** Newest nearest the corner, capped so a burst of EVA alerts cannot bury the
 * canvas. Nonblocking: the twin keeps running behind them. */
const VISIBLE = 4;

export function Toasts({ alerts, onDismiss }: { alerts: readonly Alert[]; onDismiss(id: string): void }) {
  if (!alerts.length) return null;
  return <div className="toasts" role="log" aria-label="EVA alerts">
    {alerts.slice(-VISIBLE).map((alert) => <article className={`toast toast--${alert.kind ?? 'warn'}`} key={alert.id}>
      <div className="toast__title">
        <AlertIcon />
        {alert.title}
        <button type="button" className="icon-btn icon-btn--sm" aria-label={`Acknowledge ${alert.title}`} onClick={() => onDismiss(alert.id)}><CloseIcon /></button>
      </div>
      <p className="toast__body">{alert.message}</p>
    </article>)}
  </div>;
}
