// Subjects view: one card per activity — progress, pace, controls.
import { esc } from '../model.js';
import { catLabel } from '../state.js';
import {
  todayStr, actTotal, actDone, currentCur, nextSession,
  projectFinish, requiredPerCycle, targetStats, okCls,
} from './model.js';
import { plan, setActivityStatus, setTravelMode } from './state.js';

const fmtDate = s => new Date(s + 'T12:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });

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
  h += `</div></details></div>`;
  return h;
}

export function renderSubjects() {
  const el = document.getElementById('view-subjects');
  if (!el || !plan.data) return;
  const order = { active: 0, planned: 1, parked: 2, done: 3, cancelled: 4 };
  const acts = [...plan.data.activities].sort((x, y) =>
    (order[x.status] ?? 9) - (order[y.status] ?? 9));
  el.innerHTML = acts.map(card).join('');
  el.querySelectorAll('[data-do]').forEach(b => {
    const id = b.closest('.scard').dataset.id;
    if (b.dataset.do === 'travel')
      b.addEventListener('change', () => setTravelMode(id, b.value));
    else b.addEventListener('click', () => {
      const map = { activate: 'active', park: 'parked', cancel: 'cancelled' };
      if (b.dataset.do === 'cancel' && !confirm('Cancel this activity? History is kept.')) return;
      setActivityStatus(id, map[b.dataset.do]);
    });
  });
}
