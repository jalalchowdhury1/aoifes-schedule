// Subjects view: one card per activity — progress, pace, controls.
// NO browser dialogs anywhere in the planner (prompt/alert/confirm): this runs
// on the family's phones, where a native dialog is easy to mis-tap and
// impossible to style. Cancelling is a two-tap button, exactly like year.js's
// two-tap Delete.
import { esc } from '../model.js';
import { catLabel } from '../state.js';
import {
  todayStr, actTotal, actDone, currentCur, nextSession,
  projectFinish, requiredPerCycle, targetStats, okCls,
  chainTimeline, actualFinishes, daysBetween, compareSubjects,
} from './model.js';
import { plan, setActivityStatus, setTravelMode, setBaseline, getActivity } from './state.js';

const fmtDate = s => new Date(s + 'T12:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });

// Two-tap Cancel. The armed button is mutated IN PLACE rather than re-rendered
// because the controls live inside a <details>, and re-rendering would snap it
// shut mid-decision. `armedBtn` therefore holds a DOM node and must be dropped
// on every render (the node it points at is about to be replaced).
let armedBtn = null;
let armedRest = '';                           // the label to restore on disarm
let elWired = false;                          // #view-subjects survives re-renders
const disarm = () => {
  if (armedBtn) { armedBtn.textContent = armedRest; armedBtn = null; }
};

function paceLine(a) {
  const p = plan.data, today = todayStr();
  if (a.type === 'target') {
    const st = targetStats(a, p, p.log, today);
    return st.behind > 0
      ? `<span class="pchip warn">${st.done}/${st.target} · ${st.behind} behind</span>`
      : `<span class="pchip ok">${st.done}/${st.target} on pace</span>`;
  }
  if (a.type !== 'paced' || a.status !== 'active') return '';
  if (actTotal(a) === 0) return `<span class="pchip">counts pending</span>`;
  const fin = projectFinish(a, today, p);
  if (!fin) return '';
  if (fin.done) return `<span class="pchip ok">finished 🎉</span>`;
  let out = `<span class="pchip">→ ${fmtDate(fin.date)}</span>`;
  if (a.goal?.finishBy) {
    const slackW = Math.round((new Date(a.goal.finishBy) - new Date(fin.date)) / 604800000);
    out += slackW >= 0
      ? `<span class="pchip ok">${slackW} wks ahead of goal</span>`
      : `<span class="pchip warn">${-slackW} wks past goal</span>`;
    const need = requiredPerCycle(a, today, p);
    if (need != null) out += `<span class="pchip">need ${need.toFixed(1)}/cycle</span>`;
  }
  return out;
}

// 📅 Timeline: per-chapter plan-vs-now. Active paced subjects with counts only —
// a parked/planned subject's projection would be fiction (the walk assumes she
// starts today). Complete rows show the log-attested date when one exists.
// The "current" highlight skips 0-session placeholder rows (counts pending):
// they are not workable, so they are never what she is "on".
function timelineHtml(a) {
  if (a.type !== 'paced' || a.status !== 'active' || actTotal(a) === 0) return '';
  const p = plan.data;
  const rows = chainTimeline(a, todayStr(), p);
  if (!rows.length) return '';
  const actual = actualFinishes(a, p.log);
  const base = a.baseline?.rows;
  let curSeen = false;
  const items = rows.map(r => {
    let cls = 'tl-row', right;
    if (r.complete) {
      const ad = actual[r.key];
      right = `<span class="tl-ok">✓${ad ? ' ' + fmtDate(ad) : ''}</span>`;
    } else {
      if (!curSeen && r.sessions > 0) { curSeen = true; cls += ' cur'; }
      const b = base ? base[r.key] : null;
      let chip = '';
      if (b && r.finish) {
        const dd = daysBetween(r.finish, b);            // + = ahead of plan
        const dw = Math.round(Math.abs(dd) / 7);
        if (Math.abs(dd) <= 7) chip = `<span class="pchip">≈ on plan</span>`;
        else if (dd > 0) chip = `<span class="pchip ok">${dw} wk${dw > 1 ? 's' : ''} early</span>`;
        else chip = `<span class="pchip warn">${dw} wk${dw > 1 ? 's' : ''} late</span>`;
      }
      // Each plan/now pair is one no-wrap segment so a narrow phone wraps
      // between segments, never inside a date.
      right = `<span class="tl-seg"><span class="tl-lbl">plan</span> ${b ? fmtDate(b) : '—'}</span>` +
        `<span class="tl-seg"><span class="tl-lbl">now</span> ${r.finish ? fmtDate(r.finish) : '—'}</span>${chip}`;
    }
    return `<div class="${cls}"><span class="tl-nm">${esc(r.label)}</span><span class="tl-dt">${right}</span></div>`;
  }).join('');
  return `<details class="sdet"><summary>📅 Timeline</summary><div class="tl">${items}</div></details>`;
}

function card(a) {
  const name = a.name || catLabel(a.cat);
  const total = actTotal(a), done = actDone(a);
  const cur = currentCur(a), ns = cur ? nextSession(cur) : null;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const stChip = { planned: 'Planned', parked: 'Parked', cancelled: 'Cancelled', done: 'Done' }[a.status];
  let h = `<div class="pcard scard ${a.cls ? okCls(a.cls) : ''}${a.status !== 'active' ? ' dim' : ''}" data-id="${esc(a.id)}">
    <div class="trow"><span class="tnm"><i class="sdot"></i>${esc(name)}</span>
      <span class="smeta">${stChip ? `<span class="pchip">${stChip}</span>` : paceLine(a)}</span></div>`;
  if (a.type === 'paced' && total > 0)
    h += `<div class="sline">${done}/${total}${ns ? ` · next: ${esc(ns.label)}` : ''}</div>
          <div class="sbar"><i style="width:${pct}%"></i></div>`;
  if (a.note) h += `<div class="sline">${esc(a.note)}</div>`;
  h += timelineHtml(a);
  h += `<details class="sdet"><summary>Manage</summary><div class="sctl">`;
  if (a.status === 'planned') h += `<button data-do="activate">Activate</button>`;
  if (a.status === 'active') h += `<button data-do="park">Park</button>`;
  if (a.status === 'parked') h += `<button data-do="activate">Un-park</button>`;
  if (a.status !== 'cancelled') h += `<button data-do="cancel" class="danger-btn">Cancel</button>`;
  else h += `<button data-do="activate">Restore</button>`;
  if (a.type === 'paced')
    h += `<label class="sctl-l">Travel: <select data-do="travel">
      ${['pause', 'reduced', 'continue'].map(m =>
        `<option value="${m}"${(a.travel?.mode || 'pause') === m ? ' selected' : ''}>${m}</option>`).join('')}
      </select></label>`;
  if (a.type === 'paced' && a.status === 'active' && actTotal(a) > 0)
    h += `<button data-do="baseline">${a.baseline ? 'Re-baseline' : 'Set baseline'}</button>`;
  h += `</div></details></div>`;
  return h;
}

export function renderSubjects() {
  const el = document.getElementById('view-subjects');
  if (!el || !plan.data) return;
  const acts = [...plan.data.activities].sort(compareSubjects);
  armedBtn = null;                            // the node it held is about to go
  el.innerHTML = acts.map(card).join('');
  // One delegated listener on the container, which OUTLIVES innerHTML, so it is
  // registered once ever: any tap that isn't the armed Cancel disarms it.
  if (!elWired) {
    elWired = true;
    el.addEventListener('click', e => {
      if (!e.target.closest('[data-do="cancel"],[data-do="baseline"]')) disarm();
    });
  }
  el.querySelectorAll('[data-do]').forEach(b => {
    const id = b.closest('.scard').dataset.id;
    if (b.dataset.do === 'travel')
      b.addEventListener('change', () => { disarm(); setTravelMode(id, b.value); });
    else b.addEventListener('click', () => {
      if (b.dataset.do === 'baseline') {
        if (getActivity(id)?.baseline && armedBtn !== b) {
          disarm();
          armedRest = b.textContent;
          armedBtn = b;
          b.textContent = 'Tap again to re-baseline';
          return;
        }
        disarm();
        setBaseline(id);
        return;
      }
      const map = { activate: 'active', park: 'parked', cancel: 'cancelled' };
      if (b.dataset.do === 'cancel' && armedBtn !== b) {
        disarm();                             // re-arm from some other card's button
        armedRest = b.textContent;
        armedBtn = b;
        b.textContent = 'Tap again to cancel';
        return;
      }
      disarm();
      setActivityStatus(id, map[b.dataset.do]);
    });
  });
}
