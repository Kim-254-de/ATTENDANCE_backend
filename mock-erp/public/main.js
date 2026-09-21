const STATUS = {
  students: ['active', 'deferred', 'graduated', 'discontinued'],
  staff: ['active', 'left', 'suspended'],
};
const CONFIG = {
  students: {
    title: 'Student', key: 'registrationNumber', keyLabel: 'Registration number',
    columns: [['registrationNumber', 'Reg. number'], ['fullName', 'Name'], ['programme', 'Programme'], ['yearOfStudy', 'Year'], ['status', 'Status']],
    fields: [['registrationNumber', 'Registration number', 'text'], ['fullName', 'Full name', 'text'], ['programme', 'Programme', 'text'], ['yearOfStudy', 'Year of study', 'number'], ['status', 'Status', 'select']],
  },
  staff: {
    title: 'Lecturer', key: 'staffNumber', keyLabel: 'Staff number',
    columns: [['staffNumber', 'Staff number'], ['title', 'Title'], ['fullName', 'Name'], ['email', 'Email'], ['department', 'Department'], ['faculty', 'Faculty'], ['status', 'Status']],
    fields: [['staffNumber', 'Staff number', 'text'], ['title', 'Title (Dr., Prof. …)', 'text'], ['fullName', 'Full name (without title)', 'text'], ['email', 'Email (optional)', 'email'], ['department', 'Department', 'text'], ['faculty', 'Faculty', 'text'], ['status', 'Status', 'select']],
  },
};

const $ = (id) => document.getElementById(id);
let tab = 'students';
let editing = null; // existing record being edited, or null when adding

const getKey = () => sessionStorage.getItem('erp_key');

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api/erp' + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-api-key': getKey() || '' },
    body: body && JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { lock(); throw new Error('Invalid API key'); }
  if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed'), { fields: data.errors || {} });
  return data;
}

function el(tag, props = {}, ...kids) {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids);
  return n;
}

function lock() {
  sessionStorage.removeItem('erp_key');
  $('app').hidden = true; $('lock').hidden = true; $('gate').hidden = false;
}
async function unlock(key) {
  sessionStorage.setItem('erp_key', key);
  try { await load(); } catch (e) { $('gateErr').textContent = e.message; return; }
  $('gate').hidden = true; $('app').hidden = false; $('lock').hidden = false;
}

async function load() {
  $('listErr').textContent = '';
  const p = new URLSearchParams({ q: $('search').value, status: $('statusFilter').value });
  const { results, count } = await api(`/${tab}?${p}`);
  $('count').textContent = `${count} record${count === 1 ? '' : 's'}`;
  const cfg = CONFIG[tab];
  const table = $('table');
  table.replaceChildren(
    el('thead', {}, el('tr', {}, ...cfg.columns.map(([, l]) => el('th', { textContent: l })), el('th'))),
    el('tbody', {}, ...results.map((r) => el('tr', {},
      ...cfg.columns.map(([k]) => el('td', {}, k === 'status'
        ? el('span', { className: 'badge' + (r.status === 'active' ? '' : ' inactive'), textContent: r.status })
        : document.createTextNode(r[k] ?? '—'))),
      el('td', { className: 'row-actions' },
        el('button', { textContent: 'Edit', onclick: () => openForm(r) }),
        el('button', { className: 'danger', textContent: 'Delete', onclick: () => remove(r) }))))),
  );
}

function fillFilter() {
  $('statusFilter').replaceChildren(el('option', { value: '', textContent: 'All statuses' }),
    ...STATUS[tab].map((s) => el('option', { value: s, textContent: s })));
}

function openForm(rec) {
  editing = rec || null;
  const cfg = CONFIG[tab];
  $('dlgTitle').textContent = (rec ? 'Edit ' : 'Add ') + cfg.title;
  $('formErr').textContent = '';
  $('fields').replaceChildren(...cfg.fields.map(([k, label, type]) => {
    const input = type === 'select'
      ? el('select', { name: k }, ...STATUS[tab].map((s) => el('option', { value: s, textContent: s })))
      : el('input', { name: k, type });
    input.value = rec?.[k] ?? (type === 'select' ? 'active' : '');
    if (rec && k === cfg.key) input.disabled = true; // the ID can't change
    if (k === 'fullName' || k === cfg.key) input.required = true;
    return el('label', {}, label, input, el('small', { id: 'err_' + k }));
  }));
  $('dlg').showModal();
}

$('form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const cfg = CONFIG[tab];
  const body = {};
  for (const [k] of cfg.fields) body[k] = $('fields').querySelector(`[name=${k}]`).value;
  document.querySelectorAll('#fields small').forEach((s) => (s.textContent = ''));
  try {
    if (editing) await api(`/${tab}/${encodeURIComponent(editing[cfg.key])}`, { method: 'PUT', body });
    else await api(`/${tab}`, { method: 'POST', body });
    $('dlg').close(); await load();
  } catch (e) {
    $('formErr').textContent = e.message;
    for (const [k, m] of Object.entries(e.fields || {})) if ($('err_' + k)) $('err_' + k).textContent = m;
  }
});
$('cancel').onclick = () => $('dlg').close();

async function remove(r) {
  const cfg = CONFIG[tab];
  if (!confirm(`Delete ${cfg.title.toLowerCase()} ${r[cfg.key]} (${r.fullName})?`)) return;
  try { await api(`/${tab}/${encodeURIComponent(r[cfg.key])}`, { method: 'DELETE' }); await load(); }
  catch (e) { $('listErr').textContent = e.message; }
}

document.querySelectorAll('.tab').forEach((b) => (b.onclick = () => {
  tab = b.dataset.tab;
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === b));
  $('search').value = ''; fillFilter(); load().catch((e) => ($('listErr').textContent = e.message));
}));
let t; $('search').oninput = () => { clearTimeout(t); t = setTimeout(() => load().catch(() => {}), 250); };
$('statusFilter').onchange = () => load().catch(() => {});
$('addBtn').onclick = () => openForm(null);
$('lock').onclick = lock;
$('gateForm').addEventListener('submit', (e) => { e.preventDefault(); $('gateErr').textContent = ''; unlock($('keyInput').value.trim()); });

fillFilter();
getKey() ? unlock(getKey()) : lock();
