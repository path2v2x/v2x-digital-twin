import { AlertIcon, CloseIcon } from './icons';
import type { Alert } from '../../state/twin';

/** Newest nearest the top, capped so a burst of EVA alerts cannot bury the
 * canvas. Nonblocking: the twin keeps running behind them. */
const VISIBLE = 4;

/** One surface for both kinds of notice: an EVA alert from the truth stream
 * and an operation that the server refused. Merging them is deliberate — the
 * operator wants one place to look, not two. */
export function Toasts({ alerts, onDismiss }: { alerts: readonly Alert[]; onDismiss(id: string): void }) {
  if (!alerts.length) return null;
  return <div className="toasts" role="log" aria-label="Twin notices">
    {alerts.slice(-VISIBLE).reverse().map((alert) => <article className={`toast toast--${alert.kind ?? 'warn'}`} key={alert.id}>
      <span className="toast__title"><AlertIcon />{alert.title}</span>
      <p className="toast__body">{alert.message}</p>
      <button
        type="button"
        className="icon-btn icon-btn--sm toast__close"
        aria-label={`Acknowledge ${alert.title}`}
        onClick={() => onDismiss(alert.id)}
      ><CloseIcon /></button>
    </article>)}
  </div>;
}
