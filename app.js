(() => {
  "use strict";
  const E = window.ESAME;
  const $ = (id) => document.getElementById(id);
  const CHIAVE = "esame-stato-" + E.versione;
  const SEB = /SEB[\/ ]/i.test(navigator.userAgent);
  const SEP = "¦";
  const FS_OK = !SEB && !!(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen);
  // Regole di uscita
  const SOGLIA_S = 10;     // uscite fino a 10 secondi: tollerate (solo registrate)
  const MAX_LUNGHE = 3;    // alla 3ª uscita oltre i 10 secondi la prova è annullata
  const MAX_TOTALI = 10;   // oppure alla 10ª uscita in tutto, anche se brevi

  let S = null;   // stato salvato
  let X = null;   // esame decifrato
  let timerId = null, salvaId = null, fuori = null;

  // ---------- utilità ----------
  const ora = () => new Date().toLocaleTimeString("it-IT", { hour12: false });
  const mmss = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0"); };
  const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const normCod = (s) => s.trim().toUpperCase();
  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  async function sha(s) { const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)); return Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, "0")).join(""); }

  function salva() { try { localStorage.setItem(CHIAVE, JSON.stringify(S)); } catch (e) {} }
  function salvaPresto() {
    const st = $("stato-salvataggio"); st.textContent = "Salvataggio…"; st.classList.add("attesa");
    clearTimeout(salvaId);
    salvaId = setTimeout(() => { salva(); st.textContent = "Salvato " + ora().slice(0, 5); st.classList.remove("attesa"); }, 500);
  }
  function log(tipo, dettaglio, grave) {
    if (!S) return;
    const t = Date.now();
    S.log.push({ ora: ora(), min: mmss(t - S.inizio), tipo, dettaglio: dettaglio || "", grave: !!grave });
    if (grave) S.contatori.gravi++;
    salva();
  }
  function avviso(msg) {
    const a = $("avviso"); a.textContent = msg; a.hidden = false;
    clearTimeout(avviso._t); avviso._t = setTimeout(() => (a.hidden = true), 6000);
  }

  // ---------- cifratura ----------
  async function decifra(codice) {
    for (const c of E.pacchetti) {
      try {
        const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(normCod(codice)), "PBKDF2", false, ["deriveKey"]);
        const key = await crypto.subtle.deriveKey({ name: "PBKDF2", salt: b64(c.salt), iterations: c.iterazioni, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
        const out = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64(c.iv) }, key, b64(c.dati));
        return JSON.parse(new TextDecoder().decode(out));
      } catch (e) {}
    }
    throw new Error("codice");
  }

  // ---------- avvio ----------
  function prepara() {
    document.title = E.titolo;
    $("titolo").textContent = E.titolo;
    $("corso").textContent = E.corso;
    $("docente").textContent = E.docente;
    let salvato = null;
    try { salvato = JSON.parse(localStorage.getItem(CHIAVE)); } catch (e) {}
    if (salvato && salvato.consegna) { S = salvato; mostraFine(); if (!S.consegna.inviato) invia(); return; }
    if (salvato && salvato.inizio) {
      S = salvato;
      $("nome").value = S.nome; $("matricola").value = S.matricola; $("codice").value = S.codice; $("accetto").checked = true;
      $("btn-inizia").textContent = "Riprendi la prova";
      $("errore-inizio").textContent = "È stata trovata una prova già iniziata su questo dispositivo: la ripresa verrà registrata.";
    }
    $("form-inizio").addEventListener("submit", inizia);
  }

  async function inizia(ev) {
    ev.preventDefault();
    const nome = $("nome").value.trim(), matricola = $("matricola").value.trim(), codice = $("codice").value.trim();
    const err = $("errore-inizio");
    if (!nome || !matricola || !codice) { err.textContent = "Compila nome, matricola e codice d'esame."; return; }
    if (!$("accetto").checked) { err.textContent = "Per iniziare devi accettare le regole."; return; }
    const btn = $("btn-inizia"); btn.disabled = true; btn.textContent = "Verifica del codice…";
    try { X = await decifra(codice); }
    catch (e) { err.textContent = "Codice d'esame non valido."; btn.disabled = false; btn.textContent = S ? "Riprendi la prova" : "Inizia la prova"; return; }
    const ripresa = !!(S && S.inizio);
    if (!ripresa) {
      S = { nome, matricola, codice: normCod(codice), inizio: Date.now(), r: new Array(X.nSlot).fill(""), err: {}, tarea: 0, log: [],
            contatori: { uscite: 0, lunghe: 0, gravi: 0, msFuori: 0, incolla: 0, ricariche: 0 } };
      log("Inizio prova", X.sigla + " (" + X.durataMinuti + " min) – " + (SEB ? "Safe Exam Browser" : FS_OK ? "browser a schermo intero" : "browser senza schermo intero (solo registro uscite)"));
    } else {
      S.contatori.ricariche++;
      log("Ripresa dopo ricaricamento o chiusura della pagina", "", true);
    }
    await chiediFS();
    avviaProva();
  }
  function inFS() { return !!(document.fullscreenElement || document.webkitFullscreenElement); }
  async function chiediFS() {
    if (!FS_OK || inFS()) return;
    const d = document.documentElement;
    try { await (d.requestFullscreen ? d.requestFullscreen({ navigationUI: "hide" }) : d.webkitRequestFullscreen()); } catch (e) {}
  }

  function ambiente() {
    const ua = navigator.userAgent;
    const so = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1 ? "iPadOS" : /iPad/.test(ua) ? "iPadOS" : /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "macOS" : /Android/.test(ua) ? "Android" : /iPhone/.test(ua) ? "iPhone" : /Linux/.test(ua) ? "Linux" : "altro";
    return ["SEB: " + (SEB ? "sì" : "no") + " | Schermo intero: " + (FS_OK ? "sì" : "non disponibile"), "Sistema: " + so, "Schermo: " + screen.width + "x" + screen.height, "UA: " + ua].join(" | ");
  }

  // ---------- prova ----------
  function avviaProva() {
    $("schermo-inizio").hidden = true; $("schermo-prova").hidden = false;
    $("studente").textContent = S.nome + " · " + S.matricola;
    $("sigla").textContent = X.sigla + " · " + X.sottotitolo;
    $("n-totale").textContent = X.nSlot;
    document.title = X.sigla + " – " + X.titolo;
    costruisciSchede();
    mostraTarea(S.tarea || 0);
    collegaEventi();
    aggiornaUscite();
    tick(); timerId = setInterval(tick, 1000);
  }

  function aggiornaUscite() {
    const u = $("uscite"); if (!u) return;
    u.textContent = "Uscite lunghe " + S.contatori.lunghe + "/" + MAX_LUNGHE;
    u.classList.toggle("poco", S.contatori.lunghe > 0);
  }
  function tick() {
    const resta = S.inizio + X.durataMinuti * 60000 - Date.now();
    const t = $("timer"); t.textContent = mmss(resta);
    t.classList.toggle("poco", resta < 10 * 60000);
    if (resta <= 0) { clearInterval(timerId); log("Tempo scaduto", "Consegna automatica"); consegna(true); }
  }

  // quante risposte per tarea
  function slotsTarea(T) { return T.items.flatMap((it) => (T.tipo === "errori" ? [it.s[0]] : it.s)); }
  function compilate(T) {
    if (T.tipo === "errori") return T.items.filter((it) => S.r[it.s[0]] && S.r[it.s[1]].trim()).length;
    return slotsTarea(T).filter((s) => S.r[s].trim()).length;
  }
  function totaleT(T) { return T.tipo === "errori" ? T.items.length : slotsTarea(T).length; }
  function aggiornaProgressi() {
    let n = 0, tot = 0;
    X.taree.forEach((T, i) => {
      const c = compilate(T), m = totaleT(T); n += c; tot += m;
      const chip = $("schede-tarea").children[i];
      chip.querySelector(".conta").textContent = c + "/" + m;
      chip.classList.toggle("completa", c === m);
    });
    $("n-risposte").textContent = n; $("n-totale").textContent = tot;
  }

  function costruisciSchede() {
    const nav = $("schede-tarea"); nav.innerHTML = "";
    X.taree.forEach((T, i) => {
      const b = el("button", "chip"); b.type = "button";
      b.append(el("span", "num", String(i + 1)), el("span", "nome", T.titolo), el("span", "conta", ""));
      b.addEventListener("click", () => mostraTarea(i));
      nav.appendChild(b);
    });
  }

  // testo con *corsivo*
  function testoRicco(parent, s) {
    s.split(/(\*[^*]+\*)/).forEach((p) => {
      if (/^\*[^*]+\*$/.test(p)) parent.appendChild(el("em", null, p.slice(1, -1)));
      else if (p) parent.appendChild(document.createTextNode(p));
    });
  }

  function campoTesto(slot) {
    const i = document.createElement("input");
    i.type = "text"; i.className = "hueco"; i.value = S.r[slot];
    ["autocomplete", "autocorrect", "autocapitalize"].forEach((a) => i.setAttribute(a, "off"));
    i.spellcheck = false; i.setAttribute("aria-label", "Risposta " + (slot + 1));
    const adatta = () => { i.style.width = "calc(" + Math.max(6, Math.min(26, i.value.length + 2)) + " * 0.62em + 16px)"; };
    adatta();
    i.addEventListener("input", () => { S.r[slot] = i.value.replace(/¦/g, ""); adatta(); salvaPresto(); aggiornaProgressi(); });
    return i;
  }
  function menu(slot, opzioni) {
    const s = document.createElement("select"); s.className = "hueco-menu";
    s.appendChild(new Option("—", ""));
    opzioni.forEach((o) => s.appendChild(new Option(o, o)));
    s.value = S.r[slot];
    s.setAttribute("aria-label", "Risposta " + (slot + 1));
    s.addEventListener("change", () => { S.r[slot] = s.value; salvaPresto(); aggiornaProgressi(); });
    return s;
  }

  function mostraTarea(i) {
    i = Math.max(0, Math.min(X.taree.length - 1, i));
    S.tarea = i; salva();
    const T = X.taree[i], box = $("tarea"); box.innerHTML = "";
    [...$("schede-tarea").children].forEach((c, j) => c.classList.toggle("attiva", j === i));
    $("schede-tarea").children[i].scrollIntoView({ block: "nearest", inline: "center" });

    const h = el("header", "tarea-testa");
    h.append(el("p", "occhiello", "Tarea " + (i + 1) + " de " + X.taree.length + " · " + String(T.punti).replace(".", ",") + " puntos"), el("h2", null, T.titolo), el("p", "istruzioni", T.istruzioni));
    box.appendChild(h);
    if (T.opzioni && T.tipo === "menu") {
      const banca = el("div", "banca"); T.opzioni.forEach((o) => banca.appendChild(el("span", null, o))); box.appendChild(banca);
    }
    const lista = el(T.testo ? "div" : "ol", T.testo ? "testo-continuo" : "voci");
    T.items.forEach((it, n) => {
      const li = el(T.testo ? "p" : "li", "voce");
      if (T.tipo === "huecos" || T.tipo === "menu") {
        const parti = it.t.split("___");
        parti.forEach((p, g) => {
          testoRicco(li, p);
          if (g < it.s.length) {
            const w = el("span", "gap");
            w.appendChild(T.tipo === "menu" ? menu(it.s[g], T.opzioni) : campoTesto(it.s[g]));
            if (it.h && it.h[g]) w.appendChild(el("span", "suggerimento", "(" + it.h[g] + ")"));
            li.appendChild(w);
          }
        });
      } else if (T.tipo === "multipla") {
        const q = el("p", "domanda"); testoRicco(q, it.t.replace(/___/g, "______")); li.appendChild(q);
        const g = el("div", "opzioni"); g.setAttribute("role", "radiogroup");
        it.o.forEach((o) => {
          const lab = el("label", "opzione"); const r = document.createElement("input");
          r.type = "radio"; r.name = "q" + it.s[0]; r.value = o; r.checked = S.r[it.s[0]] === o;
          r.addEventListener("change", () => { S.r[it.s[0]] = o; salvaPresto(); aggiornaProgressi(); });
          lab.append(r, el("span", null, o)); g.appendChild(lab);
        });
        li.appendChild(g);
      } else if (T.tipo === "errori") {
        const [sa, sb] = it.s;
        const frase = el("p", "frase");
        const corr = campoTesto(sb); corr.classList.add("correzione"); corr.placeholder = "forma correcta";
        const etich = el("span", "etichetta-corr");
        const aggiorna = () => {
          const idx = S.err[sa];
          [...frase.children].forEach((b, k) => b.classList.toggle("scelta", k + 1 === idx));
          corr.disabled = !idx;
          etich.textContent = idx ? "«" + it.tok[idx - 1].replace(/[.,;:!?¡¿«»"()]/g, "") + "» →" : "Toca la palabra equivocada";
        };
        it.tok.forEach((w, k) => {
          const b = el("button", "parola", w); b.type = "button";
          b.addEventListener("click", () => {
            if (S.err[sa] === k + 1) { delete S.err[sa]; S.r[sa] = ""; }
            else { S.err[sa] = k + 1; S.r[sa] = (k + 1) + ":" + w; }
            aggiorna(); salvaPresto(); aggiornaProgressi();
            if (S.err[sa]) corr.focus();
          });
          frase.appendChild(b);
        });
        const riga = el("div", "riga-corr"); riga.append(etich, corr);
        li.append(frase, riga); aggiorna();
      }
      lista.appendChild(li);
    });
    box.appendChild(lista);
    $("btn-prec").disabled = i === 0;
    $("btn-succ").textContent = i === X.taree.length - 1 ? "Consegna la prova" : "Tarea siguiente →";
    $("foglio").scrollTop = 0; window.scrollTo(0, 0);
    aggiornaProgressi();
  }

  // ---------- controlli ----------
  let collegati = false;
  function collegaEventi() {
    if (collegati) return; collegati = true;
    $("btn-prec").addEventListener("click", () => mostraTarea(S.tarea - 1));
    $("btn-succ").addEventListener("click", () => (S.tarea === X.taree.length - 1 ? chiediConferma() : mostraTarea(S.tarea + 1)));

    const blocca = (msg, tipo) => (e) => { e.preventDefault(); S.contatori.incolla += tipo === "incolla" ? 1 : 0; log(msg, "", true); avviso(msg.replace(" (bloccato)", " non è consentito") + ". Il tentativo è stato registrato."); };
    document.addEventListener("paste", blocca("Incollare (bloccato)", "incolla"), true);
    document.addEventListener("drop", blocca("Trascinare testo (bloccato)", "incolla"), true);
    document.addEventListener("copy", blocca("Copiare (bloccato)"), true);
    document.addEventListener("cut", blocca("Tagliare (bloccato)"), true);
    document.addEventListener("beforeinput", (e) => {
      const t = e.inputType || "";
      if (t.startsWith("insertFromPaste") || t === "insertFromDrop") { e.preventDefault(); S.contatori.incolla++; log("Incollare (bloccato)", "", true); avviso("Incollare non è consentito. Il tentativo è stato registrato."); }
      if (t === "insertReplacementText") log("Sostituzione automatica (correttore)", (e.data || "").slice(0, 40));
    }, true);
    document.addEventListener("contextmenu", (e) => e.preventDefault());
    document.addEventListener("dragstart", (e) => e.preventDefault());
    document.addEventListener("selectstart", (e) => { if (!(e.target.closest && e.target.closest("input"))) e.preventDefault(); });
    document.addEventListener("keydown", (e) => {
      const k = (e.key || "").toLowerCase(), mod = e.ctrlKey || e.metaKey;
      if (mod && ["v", "c", "x", "a", "z"].includes(k)) return;
      if ((mod && ["p", "s", "u", "f", "g", "o", "n", "t", "r"].includes(k)) || k === "f12" || k === "f5" || (mod && e.shiftKey && ["i", "j", "c"].includes(k))) {
        e.preventDefault(); log("Scorciatoia bloccata", (e.metaKey ? "Cmd+" : "Ctrl+") + (e.shiftKey ? "Maiusc+" : "") + e.key, true);
      }
      if (e.key === "Enter" && e.target.classList && e.target.classList.contains("hueco")) {
        e.preventDefault();
        const campi = [...document.querySelectorAll(".hueco:not([disabled])")];
        const j = campi.indexOf(e.target); if (campi[j + 1]) campi[j + 1].focus();
      }
    }, true);

    const esce = (motivo) => { if (fuori || S.consegna) return; fuori = { inizio: Date.now(), motivo }; salva(); };
    const rientra = (forza) => {
      if (!fuori || S.consegna) return;
      if (document.hidden || (!forza && (!document.hasFocus() || (FS_OK && !inFS())))) return;
      const d = Date.now() - fuori.inizio, motivo = fuori.motivo; fuori = null;
      S.contatori.uscite++; S.contatori.msFuori += d;
      const lunga = d > SOGLIA_S * 1000;
      if (lunga) S.contatori.lunghe++;
      log(lunga ? "USCITA LUNGA" : "Uscita breve", motivo + ", fuori per " + mmss(d) + " (lunghe " + S.contatori.lunghe + "/" + MAX_LUNGHE + ", totali " + S.contatori.uscite + "/" + MAX_TOTALI + ")", lunga);
      aggiornaUscite();
      if (S.contatori.lunghe >= MAX_LUNGHE || S.contatori.uscite >= MAX_TOTALI) {
        S.annullata = S.contatori.lunghe >= MAX_LUNGHE ? MAX_LUNGHE + " uscite di oltre " + SOGLIA_S + " secondi" : MAX_TOTALI + " uscite in totale";
        log("PROVA ANNULLATA", S.annullata, true);
        consegna(false); return;
      }
      const restaL = MAX_LUNGHE - S.contatori.lunghe, restaT = MAX_TOTALI - S.contatori.uscite;
      $("velo-titolo").textContent = lunga ? "Attenzione: uscita registrata" : "Sei uscito dalla prova";
      $("velo-testo").textContent = (lunga
        ? "Sei stato fuori per " + mmss(d) + ". Ancora " + restaL + (restaL === 1 ? " uscita" : " uscite") + " di oltre " + SOGLIA_S + " secondi e la prova verrà annullata."
        : "Sei stato fuori per " + mmss(d) + ". Le uscite brevi sono tollerate, ma alla " + MAX_TOTALI + "ª uscita la prova verrà annullata (ne restano " + restaT + ").");
      $("velo").hidden = false;
    };
    document.addEventListener("visibilitychange", () => (document.hidden ? esce("pagina nascosta (altra app o scheda)") : rientra()));
    window.addEventListener("blur", () => setTimeout(() => { if (!document.hasFocus() && !document.querySelector("select:focus")) esce("finestra non attiva (altra app o finestra)"); }, 200));
    window.addEventListener("focus", () => setTimeout(() => rientra(), 50));
    window.addEventListener("pagehide", () => { esce("pagina chiusa o ricaricata"); salva(); });
    const fsCambio = () => {
      if (!FS_OK || S.consegna) return;
      if (!inFS()) { esce("uscita dallo schermo intero"); $("velo-titolo").textContent = "Sei uscito dallo schermo intero"; $("velo-testo").textContent = "Premi «Torna alla prova» subito: se resti fuori più di " + SOGLIA_S + " secondi l'uscita conta come lunga."; $("velo").hidden = false; }
      else rientra();
    };
    document.addEventListener("fullscreenchange", fsCambio);
    document.addEventListener("webkitfullscreenchange", fsCambio);
    $("btn-rientra").addEventListener("click", async () => { await chiediFS(); $("velo").hidden = true; rientra(true); });

    $("btn-consegna").addEventListener("click", chiediConferma);
    $("btn-annulla").addEventListener("click", () => ($("conferma").hidden = true));
    $("btn-conferma").addEventListener("click", () => { $("conferma").hidden = true; consegna(false); });
  }

  function chiediConferma() {
    const mancano = X.taree.map((T, i) => ({ i, m: totaleT(T) - compilate(T) })).filter((x) => x.m > 0);
    const tot = mancano.reduce((a, x) => a + x.m, 0);
    $("conferma-testo").textContent = tot
      ? "Hai ancora " + tot + (tot === 1 ? " risposta vuota" : " risposte vuote") + " (tareas " + mancano.map((x) => x.i + 1).join(", ") + "). Dopo la consegna non potrai più modificare le risposte."
      : "Hai risposto a tutto. Dopo la consegna non potrai più modificare le risposte.";
    $("conferma").hidden = false;
  }

  // ---------- consegna ----------
  function stringaRisposte() {
    const r = S.r.slice();
    X.taree.filter((T) => T.tipo === "errori").forEach((T) => T.items.forEach((it) => {
      const [a, b] = it.s;
      r[b] = r[a] && r[b].trim() ? r[a] + " → " + r[b].trim() : "";
    }));
    return r.map((x) => "_" + x.replace(/¦/g, "").replace(/[\r\n\t]+/g, " ").trim()).join(SEP);
  }
  function riepilogo() {
    const c = S.contatori, gravi = S.log.filter((x) => x.grave);
    const n = X.taree.reduce((a, T) => a + compilate(T), 0), tot = X.taree.reduce((a, T) => a + totaleT(T), 0);
    return [
      "Ricevuta: " + S.consegna.ricevuta,
      "Esito controlli: " + (S.annullata ? "PROVA ANNULLATA (" + S.annullata + ")" : gravi.length ? "DA VERIFICARE (" + gravi.length + " eventi segnalati)" : "nessuna anomalia"),
      "Uscite dalla prova: " + c.uscite + ", di cui oltre " + SOGLIA_S + " s: " + (c.lunghe || 0) + " (tempo fuori " + mmss(c.msFuori) + ")",
      "Tentativi di incollare: " + c.incolla,
      "Ripresa dopo ricaricamento: " + c.ricariche,
      "Durata: " + mmss(S.consegna.fine - S.inizio) + (S.consegna.automatica ? " (consegna automatica)" : ""),
      "Risposte date: " + n + " / " + tot,
    ].join("\n");
  }
  function registro() {
    let r = S.log.map((x) => (x.grave ? "[!] " : "    ") + x.ora + " (min " + x.min + ") " + x.tipo + (x.dettaglio ? " – " + x.dettaglio : "")).join("\n");
    if (r.length > 40000) r = r.slice(0, 40000) + "\n… registro troncato";
    return r;
  }

  async function consegna(automatica) {
    if (S.consegna) return;
    clearInterval(timerId);
    log(S.annullata ? "Consegna forzata (prova annullata)" : automatica ? "Consegna automatica (tempo scaduto)" : "Consegna da parte dello studente");
    if (inFS()) { try { document.exitFullscreen ? document.exitFullscreen() : document.webkitExitFullscreen(); } catch (e) {} }
    const fine = Date.now(), risposte = stringaRisposte();
    const ricevuta = (await sha(S.matricola + "|" + risposte + "|" + fine)).slice(0, 8).toUpperCase().replace(/(.{4})/, "$1-");
    S.consegna = { fine, ricevuta, automatica, inviato: false, tentativi: 0, risposte, riepilogo: "", ambiente: ambiente(), sigla: X.sigla + " – " + X.titolo };
    S.consegna.riepilogo = riepilogo();
    salva(); mostraFine(); invia();
  }

  async function invia() {
    $("btn-riprova").hidden = true;
    $("fine-titolo").textContent = "Consegna in corso…";
    $("fine-testo").textContent = "Non chiudere questa pagina.";
    const f = E.form, p = new URLSearchParams(), C = S.consegna;
    p.append(f.nome, S.nome); p.append(f.matricola, S.matricola);
    p.append(f.codiceEsame, C.sigla + " · codice " + S.codice);
    p.append(f.risposte, C.risposte); p.append(f.registro, registro()); p.append(f.riepilogo, C.riepilogo); p.append(f.ambiente, C.ambiente);
    C.tentativi++; salva();
    try {
      await fetch(f.action, { method: "POST", mode: "no-cors", body: p });
      C.inviato = true; salva();
      $("fine-titolo").textContent = S.annullata ? "Prova annullata" : "Prova consegnata";
      $("fine-testo").textContent = S.annullata ? "Sei uscito dalla prova troppe volte (" + S.annullata + "). Le risposte sono state inviate alla docente, che deciderà come procedere." : "Le tue risposte sono arrivate alla docente. Conserva il codice di ricevuta qui sotto.";
      $("btn-esci").hidden = false;
    } catch (e) {
      $("fine-titolo").textContent = "Invio non riuscito";
      $("fine-testo").textContent = "Le risposte sono salvate su questo dispositivo. Non chiudere la pagina, avvisa la docente e premi «Riprova l'invio».";
      $("btn-riprova").hidden = false;
      setTimeout(() => { if (!C.inviato) invia(); }, 15000);
    }
  }

  function mostraFine() {
    ["schermo-inizio", "schermo-prova", "velo", "conferma"].forEach((id) => ($(id).hidden = true));
    $("schermo-fine").hidden = false;
    $("ricevuta").hidden = false; $("ricevuta").textContent = "Ricevuta " + S.consegna.ricevuta;
  }
  $("btn-riprova").addEventListener("click", invia);

  if (/[?&]reset\b/.test(location.search)) { localStorage.removeItem(CHIAVE); history.replaceState(null, "", location.pathname); }
  prepara();
})();
