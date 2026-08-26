/**
 * Le style et le script de la feuille de décision — issue #191, lot 2, §6.
 *
 * `STYLE_CSS` est `~/.claude/skills/decision-sheet/reference/style.css`, gelé
 * verbatim. Ne l'édite jamais ici : une modification du style se fait dans la
 * skill, pas dans ce fichier.
 *
 * `SCRIPT` est le script du squelette (`reference/skeleton.html`), gelé de la
 * même façon, à **une exception documentée** : `save()`/`load()`/`build()`
 * indexent sur l'identité stable du plan (`data-key`), pas sur le rang
 * (`data-q`). Un plan inséré au milieu d'une planche régénérée décale tous
 * les rangs ; indexer sur le rang réassignerait silencieusement les réponses
 * à d'autres plans. La même modification fait porter le commit à l'objet
 * stocké : une réponse posée sous un commit antérieur reste affichée, mais le
 * copié-collé la marque `(sous <sha>)` plutôt que de la faire disparaître.
 */

export const STYLE_CSS = `/* Frozen decision-sheet stylesheet. Paste this whole file, verbatim, inside a single
   <style> element in the artifact HTML — see reference/skeleton.html. Do not edit. */
:root{
  --paper:#E8ECF0; --card:#FFFFFF; --card-2:#F3F6F8; --sunk:#DDE3E9;
  --ink:#12181E; --ink-2:#48535D; --ink-3:#79858E;
  --line:#D2D9E0; --line-2:#B2BCC5;
  --accent:#8F5405; --accent-line:#9A6208; --accent-soft:#FAF0DA; --sig:#9A6208; --on-accent:#FFFFFF;
  --ok:#1C6B47;
  --shadow:0 1px 2px rgba(18,24,30,.05), 0 10px 28px -16px rgba(18,24,30,.28);
  --measure:44rem; --wide:53rem;
}
@media (prefers-color-scheme: dark){
  :root:not([data-theme="light"]){
    --paper:#0D1216; --card:#161D23; --card-2:#1C242B; --sunk:#0A0F13;
    --ink:#E7EDF2; --ink-2:#A2AFB9; --ink-3:#77838C;
    --line:#28323A; --line-2:#3B4952;
    --accent:#F0B429; --accent-line:#8A6415; --accent-soft:#241C0E; --sig:#E8AE33; --on-accent:#12181E;
    --ok:#54C18C;
    --shadow:0 1px 2px rgba(0,0,0,.4), 0 12px 30px -18px rgba(0,0,0,.8);
  }
}
:root[data-theme="dark"]{
  --paper:#0D1216; --card:#161D23; --card-2:#1C242B; --sunk:#0A0F13;
  --ink:#E7EDF2; --ink-2:#A2AFB9; --ink-3:#77838C;
  --line:#28323A; --line-2:#3B4952;
  --accent:#F0B429; --accent-line:#8A6415; --accent-soft:#241C0E; --sig:#E8AE33; --on-accent:#12181E;
  --ok:#54C18C;
  --shadow:0 1px 2px rgba(0,0,0,.4), 0 12px 30px -18px rgba(0,0,0,.8);
}

*{box-sizing:border-box}
body{
  margin:0; background:var(--paper); color:var(--ink);
  font-family:"Source Serif 4",Georgia,serif; font-size:17px; line-height:1.6;
  -webkit-font-smoothing:antialiased;
}
.wrap{max-width:var(--wide); margin:0 auto; padding:0 20px 96px}
.col{max-width:var(--measure); margin-inline:auto}

/* ---------- progress bar ---------- */
.bar{
  position:sticky; top:0; z-index:20; background:var(--paper);
  border-bottom:1px solid var(--line);
}
.bar-in{
  max-width:var(--wide); margin:0 auto; padding:10px 20px;
  display:flex; align-items:center; gap:14px;
}
.bar-label{
  font-family:Archivo,system-ui,sans-serif; font-size:11.5px; font-weight:600;
  letter-spacing:.10em; text-transform:uppercase; color:var(--ink-2);
  white-space:nowrap; font-variant-numeric:tabular-nums;
}
.track{flex:1; height:4px; background:var(--sunk); border-radius:2px; overflow:hidden}
.fill{height:100%; width:0%; background:var(--accent); border-radius:2px; transition:width .25s ease}

/* ---------- header ---------- */
header{padding:52px 0 8px}
.eyebrow{
  font-family:Archivo,system-ui,sans-serif; font-size:11.5px; font-weight:600;
  letter-spacing:.14em; text-transform:uppercase; color:var(--accent); margin:0 0 14px;
}
h1{
  font-family:Archivo,system-ui,sans-serif; font-weight:700; font-size:clamp(2rem,5.5vw,2.9rem);
  line-height:1.06; letter-spacing:-.022em; margin:0 0 16px; text-wrap:balance;
}
.lede{font-size:1.08rem; color:var(--ink-2); margin:0; max-width:36rem}

/* ---------- settled band ---------- */
.settled{
  margin:36px 0 8px; padding:18px 20px; background:var(--card-2);
  border:1px solid var(--line); border-radius:10px;
}
.settled h2{
  font-family:Archivo,system-ui,sans-serif; font-size:11.5px; font-weight:600;
  letter-spacing:.12em; text-transform:uppercase; color:var(--ink-3); margin:0 0 12px;
}
.settled ul{margin:0; padding:0; list-style:none; display:grid; gap:8px}
.settled li{display:flex; gap:10px; font-size:.95rem; color:var(--ink-2); line-height:1.45}
.settled b{color:var(--ink); font-weight:600}
.tick{color:var(--ok); flex:none; font-family:Archivo,sans-serif; font-weight:700}

/* ---------- question cards ---------- */
.q{
  margin:34px 0 0; background:var(--card); border:1px solid var(--line);
  border-radius:14px; box-shadow:var(--shadow); overflow:hidden;
}
.q-head{padding:24px 26px 4px}
.q-num{
  font-family:"JetBrains Mono",ui-monospace,monospace; font-size:12px; font-weight:500;
  color:var(--accent); letter-spacing:.04em;
}
.q-title{
  font-family:Archivo,system-ui,sans-serif; font-weight:700; font-size:1.42rem;
  letter-spacing:-.014em; line-height:1.18; margin:6px 0 10px; text-wrap:balance;
}
.q-stake{margin:0; color:var(--ink-2); font-size:1rem}

figure{margin:20px 0 4px; padding:18px 20px; background:var(--card-2); border-block:1px solid var(--line)}
figure svg{display:block; width:100%; max-width:100%; height:auto; color:var(--ink-2)}
figcaption{
  margin-top:12px; font-size:.86rem; color:var(--ink-3); line-height:1.5;
  font-family:Archivo,system-ui,sans-serif; text-wrap:balance;
}

.opts{padding:20px 26px 4px; display:grid; gap:10px}
.opt{
  display:grid; grid-template-columns:auto 1fr; gap:14px; align-items:start;
  padding:14px 16px; border:1px solid var(--line); border-radius:10px;
  cursor:pointer; background:var(--card);
}
.opt:hover{border-color:var(--line-2)}
.opt input{
  appearance:none; -webkit-appearance:none; margin:3px 0 0; width:18px; height:18px;
  border:1.5px solid var(--line-2); border-radius:50%; flex:none; cursor:pointer;
  display:grid; place-content:center; background:var(--card);
}
.opt input::after{content:""; width:9px; height:9px; border-radius:50%; transform:scale(0); background:var(--accent)}
.opt input:checked::after{transform:scale(1)}
.opt input:checked{border-color:var(--accent)}
.opt input:focus-visible{outline:2px solid var(--accent); outline-offset:3px}
.opt:has(input:checked), .opt.is-on{border-color:var(--accent); background:var(--accent-soft)}
.opt-t{
  font-family:Archivo,system-ui,sans-serif; font-weight:600; font-size:1rem;
  display:flex; flex-wrap:wrap; align-items:center; gap:8px; line-height:1.3;
}
.opt-d{margin:5px 0 0; font-size:.93rem; color:var(--ink-2); line-height:1.5}
.reco{
  font-family:Archivo,sans-serif; font-size:10px; font-weight:700; letter-spacing:.09em;
  text-transform:uppercase; color:var(--accent); border:1px solid var(--accent-line);
  border-radius:99px; padding:2px 8px; white-space:nowrap;
}

details{margin:14px 26px 0; border-top:1px solid var(--line); padding-top:12px}
summary{
  cursor:pointer; font-family:Archivo,sans-serif; font-size:12px; font-weight:600;
  letter-spacing:.07em; text-transform:uppercase; color:var(--ink-3); list-style:none;
}
summary::-webkit-details-marker{display:none}
summary::before{content:"▸ "; color:var(--accent)}
details[open] summary::before{content:"▾ "}
summary:focus-visible{outline:2px solid var(--accent); outline-offset:3px; border-radius:3px}
.why{margin:12px 0 0; font-size:.94rem; color:var(--ink-2); line-height:1.6}
.why p{margin:0 0 9px}
.why p:last-child{margin-bottom:0}
code, .m{
  font-family:"JetBrains Mono",ui-monospace,monospace; font-size:.86em;
  background:var(--sunk); padding:1px 5px; border-radius:4px; color:var(--ink);
}
.num{font-variant-numeric:tabular-nums; font-weight:600; color:var(--ink)}

.note{padding:14px 26px 22px}
.note input{
  width:100%; font-family:"Source Serif 4",Georgia,serif; font-size:.93rem;
  padding:9px 12px; border:1px solid var(--line); border-radius:8px;
  background:var(--card-2); color:var(--ink);
}
.note input::placeholder{color:var(--ink-3)}
.note input:focus-visible{outline:2px solid var(--accent); outline-offset:1px; border-color:var(--accent)}

/* ---------- live/dead lists ---------- */
.split{display:grid; grid-template-columns:1fr 1fr; gap:16px; margin:20px 26px 0}
@media (max-width:640px){ .split{grid-template-columns:1fr} }
.pane{border:1px solid var(--line); border-radius:10px; padding:14px 16px; background:var(--card-2)}
.pane h4{
  font-family:Archivo,sans-serif; font-size:11px; font-weight:700; letter-spacing:.11em;
  text-transform:uppercase; margin:0 0 10px;
}
.pane.live h4{color:var(--ok)}
.pane.dead h4{color:var(--accent)}
.pane ul{margin:0; padding:0; list-style:none; display:grid; gap:5px}
.pane li{
  font-family:"JetBrains Mono",ui-monospace,monospace; font-size:12px; color:var(--ink-2);
  display:flex; justify-content:space-between; gap:10px; font-variant-numeric:tabular-nums;
}
.pane li span{color:var(--ink-3)}
.pane .tot{border-top:1px solid var(--line); margin-top:6px; padding-top:6px; color:var(--ink); font-weight:500}

/* ---------- output ---------- */
.out{margin:44px 0 0; padding:26px; background:var(--card); border:1px solid var(--line); border-radius:14px; box-shadow:var(--shadow)}
.out h2{font-family:Archivo,sans-serif; font-weight:700; font-size:1.3rem; margin:0 0 6px; letter-spacing:-.012em}
.out p.sub{margin:0 0 18px; color:var(--ink-2); font-size:.96rem}
textarea{
  width:100%; min-height:120px; font-family:"Source Serif 4",Georgia,serif; font-size:.95rem;
  padding:11px 13px; border:1px solid var(--line); border-radius:8px;
  background:var(--card-2); color:var(--ink); resize:vertical; line-height:1.5;
}
textarea:focus-visible{outline:2px solid var(--accent); outline-offset:1px; border-color:var(--accent)}
pre{
  margin:18px 0 0; padding:16px 18px; background:var(--sunk); border-radius:10px;
  font-family:"JetBrains Mono",ui-monospace,monospace; font-size:12.5px; line-height:1.65;
  color:var(--ink); overflow-x:auto; white-space:pre; border:1px solid var(--line);
}
.actions{display:flex; gap:12px; align-items:center; margin-top:18px; flex-wrap:wrap}
button{
  font-family:Archivo,sans-serif; font-size:14px; font-weight:600; letter-spacing:.01em;
  padding:11px 20px; border-radius:9px; border:1px solid transparent;
  background:var(--accent); color:var(--on-accent); cursor:pointer;
}
button:hover{filter:brightness(1.08)}
button:focus-visible{outline:2px solid var(--accent); outline-offset:3px}
button.ghost{background:transparent; color:var(--ink-2); border-color:var(--line-2)}
.status{font-family:Archivo,sans-serif; font-size:13px; color:var(--ok); font-weight:600}

footer{margin:40px 0 0; text-align:center; color:var(--ink-3); font-size:.86rem; font-family:Archivo,sans-serif}

@media (prefers-reduced-motion: reduce){ *{transition:none !important; animation:none !important} }
`

/**
 * Bloc additif, marqué et distinct du CSS gelé ci-dessus — classes propres à
 * la planche, aucun littéral de couleur, uniquement les jetons existants.
 * `--wide` (jeton de mise en page, pas de couleur) élargit les sections `.q`
 * de la planche : `--measure` (44rem) est trop étroit pour deux cadres 9:16
 * côte à côte.
 */
export const BOARD_CSS = `/* ===== additive: board-specific classes (issue 191) ===== */
.q--board{max-width:var(--wide)}
.frames{display:flex; flex-wrap:wrap; gap:16px; margin:20px 0 4px}
.variant{flex:1 1 220px; min-width:180px}
.variant img{display:block; width:100%; height:auto; border-radius:8px; border:1px solid var(--line); background:var(--sunk)}
.variant figcaption{margin-top:8px}
.variant .variant-label{
  display:block; font-family:Archivo,system-ui,sans-serif; font-size:11px; font-weight:600;
  letter-spacing:.06em; text-transform:uppercase; color:var(--ink-3); margin:0 0 6px;
}
.share{font-variant-numeric:tabular-nums; color:var(--ink-2)}
`

/**
 * `JSON.stringify` puis échappe `<` — sans quoi une valeur portant `</script>`
 * (une note libre, un `probes`) fermerait la balise et exécuterait le reste
 * comme du HTML (relevé par Aristarque sur la #192).
 */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

/**
 * Le script du squelette, gelé, avec la seule exception documentée en tête de
 * fichier. `KEY`, `SETTLED`, `T` et `COMMIT` sont composés par
 * l'appelant (`page.ts`) via `JSON.stringify`, jamais par un remplacement de
 * `{{}}` sur ce texte.
 */
export function renderScript(o: {
  key: string
  commit: string
  settled: readonly (readonly [string, string])[]
  strings: {
    progressNoun: string
    copyOutTitle: string
    settledHeading: string
    undecided: string
    noteLabel: string
    remarksHeading: string
    copied: string
    copyRefused: string
    cleared: string
  }
}): string {
  return `(function () {
  'use strict';
  var KEY = ${jsonForScript(o.key)};
  var COMMIT = ${jsonForScript(o.commit)};
  var sections = Array.prototype.slice.call(document.querySelectorAll('.q'));
  var preview = document.getElementById('preview');
  var remarks = document.getElementById('remarks');
  var status = document.getElementById('status');
  var fill = document.getElementById('fill');
  var prog = document.getElementById('prog');

  var SETTLED = ${jsonForScript(o.settled)};

  var T = ${jsonForScript(o.strings)};

  function answerOf(n) {
    var el = document.querySelector('input[name="q' + n + '"]:checked');
    return el ? el.value : null;
  }
  function noteOf(n) {
    var el = document.querySelector('[data-note="' + n + '"]');
    return el && el.value.trim() ? el.value.trim() : null;
  }

  function build() {
    var lines = [T.copyOutTitle, ''];
    lines.push(T.settledHeading);
    SETTLED.forEach(function (s) { lines.push('  · ' + s[0] + ' : ' + s[1]); });
    lines.push('');
    sections.forEach(function (sec) {
      var n = sec.getAttribute('data-q');
      var a = answerOf(n);
      var note = noteOf(n);
      lines.push(sec.getAttribute('data-key') + ' — ' + sec.getAttribute('data-label'));
      lines.push('  → ' + (a === null ? T.undecided : a));
      if (note) lines.push('  ' + T.noteLabel + ' : ' + note.split('\\n').join('\\n    '));
      var savedCommit = sec.getAttribute('data-answer-commit');
      if (savedCommit && savedCommit !== COMMIT) lines.push('  (sous ' + savedCommit + ')');
      lines.push('');
    });
    var r = remarks.value.trim();
    if (r) { lines.push(T.remarksHeading); lines.push('  ' + r.split('\\n').join('\\n  ')); lines.push(''); }
    return lines.join('\\n').replace(/\\n+$/, '\\n');
  }

  function paint() {
    var done = sections.filter(function (s) { return answerOf(s.getAttribute('data-q')) !== null; }).length;
    prog.textContent = done + ' / ' + sections.length + ' ' + T.progressNoun;
    fill.style.width = (done / sections.length * 100) + '%';
    preview.textContent = build();
    document.querySelectorAll('.opt').forEach(function (l) {
      var i = l.querySelector('input');
      l.classList.toggle('is-on', !!(i && i.checked));
    });
  }

  // Seule exception au script gelé : indexé sur \`data-key\`, l'identité
  // stable du plan, jamais sur \`data-q\` (le rang), qui se décale dès qu'une
  // planche régénérée insère un cas au milieu — voir l'en-tête du fichier.
  function save() {
    var data = { remarks: remarks.value, commit: COMMIT, a: {}, n: {} };
    sections.forEach(function (s) {
      var q = s.getAttribute('data-q');
      var key = s.getAttribute('data-key');
      data.a[key] = answerOf(q);
      data.n[key] = noteOf(q);
    });
    try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) { /* storage unavailable */ }
  }

  function load() {
    var raw = null;
    try { raw = localStorage.getItem(KEY); } catch (e) { return; }
    if (!raw) return;
    var data;
    try { data = JSON.parse(raw); } catch (e) { return; }
    if (!data || typeof data !== 'object') return;
    remarks.value = data.remarks || '';
    var fromOtherCommit = data.commit && data.commit !== COMMIT;
    sections.forEach(function (s) {
      var q = s.getAttribute('data-q');
      var key = s.getAttribute('data-key');
      var v = data.a && data.a[key];
      if (v) {
        var hit = Array.prototype.slice.call(document.querySelectorAll('input[name="q' + q + '"]'))
          .filter(function (i) { return i.value === v; })[0];
        if (hit) hit.checked = true;
        if (fromOtherCommit) s.setAttribute('data-answer-commit', data.commit);
      }
      var note = document.querySelector('[data-note="' + q + '"]');
      if (note && data.n && data.n[key]) note.value = data.n[key];
    });
  }

  document.addEventListener('change', function (e) {
    if (e.target && e.target.type === 'radio') { paint(); save(); }
  });
  document.addEventListener('input', function (e) {
    if (e.target && (e.target.hasAttribute('data-note') || e.target.id === 'remarks')) { paint(); save(); }
  });

  document.getElementById('copy').addEventListener('click', function () {
    var text = build();
    function ok() {
      status.textContent = T.copied;
      setTimeout(function () { status.textContent = ''; }, 2600);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(ok, fallback);
    } else { fallback(); }
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); ok(); }
      catch (err) { status.textContent = T.copyRefused; }
      document.body.removeChild(ta);
    }
  });

  document.getElementById('reset').addEventListener('click', function () {
    document.querySelectorAll('input[type="radio"]').forEach(function (i) { i.checked = false; });
    document.querySelectorAll('[data-note]').forEach(function (i) { i.value = ''; });
    remarks.value = '';
    try { localStorage.removeItem(KEY); } catch (e) { /* storage unavailable */ }
    paint();
    status.textContent = T.cleared;
    setTimeout(function () { status.textContent = ''; }, 2000);
  });

  load();
  paint();
})();`
}
