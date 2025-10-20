import React, { useEffect, useMemo, useState } from "react";
import { createClient, type Session } from "@supabase/supabase-js";

// ---------- Supabase (.env richiesto) ----------
const URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
const sb = URL && KEY ? createClient(URL, KEY) : null;

// ---------- Tipi ----------
type TimeSlot = "Mattina" | "Mezzogiorno" | "Sera";
type Profile = { id: string; email: string; family_id: string | null; role: "admin" | "member" };
type Med = {
  id: string; family_id: string; name: string; dosage: string | null;
  per_dose: number; times: TimeSlot[]; threshold: number; archived?: boolean;
};
type StocksMap = Record<string, { box: number; dispensa: number }>;

const TIMES: TimeSlot[] = ["Mattina", "Mezzogiorno", "Sera"];
const TIME_COLORS: Record<TimeSlot, string> = {
  Mattina: "#E8F4FF",      // azzurrino
  Mezzogiorno: "#FFF6E5",  // arancione chiaro
  Sera: "#F3E8FF",         // lilla chiaro
};
const todayISO = () => new Date().toISOString().slice(0, 10);
const startOfWeekISO = () => { const d = new Date(); const day = (d.getDay() + 6) % 7; d.setDate(d.getDate() - day); return d.toISOString().slice(0, 10); };
const addDaysISO = (iso: string, n: number) => { const d = new Date(iso); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

// ---------- App Wrapper ----------
export default function App() {
  if (!sb) {
    return (
      <Wrap>
        <h1>💊 Farmaci Giannina</h1>
        <p style={{ color: "crimson" }}>
          Mancano le variabili <code>.env</code>: <b>VITE_SUPABASE_URL</b> e <b>VITE_SUPABASE_ANON_KEY</b>.
        </p>
        <p>Inseriscile, salva e riavvia <code>npm run dev</code>.</p>
      </Wrap>
    );
  }
  return <AuthedApp />;
}

// ---------- Auth & Profile ----------
function AuthedApp() {
  const [session, setSession] = useState<Session | null>(null);
  const [email, setEmail] = useState("");
  const [profile, setProfile] = useState<Profile | null>(null);

  useEffect(() => {
    let unsub: (() => void) | undefined;
    sb!.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = sb!.auth.onAuthStateChange((_e, s) => setSession(s));
    unsub = () => data.subscription.unsubscribe();
    return () => { unsub?.(); };
  }, []);

  useEffect(() => {
    if (!session) return;
    sb!.from("profiles")
      .select("id,email,family_id,role")
      .eq("id", session.user.id)
      .single()
      .then(({ data }) => setProfile(data as Profile));
  }, [session]);

  if (!session) {
    return (
      <Wrap>
        <Title />
        <p>Inserisci la tua email per ricevere il link di accesso.</p>
        <input
          type="email" value={email} onChange={(e) => setEmail(e.target.value)}
          placeholder="la-tua-email@..." style={styles.input}
        />
        <button
          style={styles.btn}
          onClick={async () => {
            const { error } = await sb!.auth.signInWithOtp({ email });
            alert(error ? error.message : "Email inviata. Controlla la posta.");
          }}
        >
          Invia link di login
        </button>
      </Wrap>
    );
  }

  if (!profile) {
    return (
      <Wrap>
        <Title />
        <p>Caricamento profilo…</p>
        <Small onClick={() => sb!.auth.signOut()}>Esci</Small>
      </Wrap>
    );
  }

  return <Dashboard profile={profile} onLogout={() => sb!.auth.signOut()} />;
}

// ---------- Dashboard ----------
function Dashboard({ profile, onLogout }: { profile: Profile; onLogout: () => void }) {
  const [weekStart, setWeekStart] = useState(startOfWeekISO());
  const [view, setView] = useState<"planner" | "stocks">("planner");
  const [onlyToday, setOnlyToday] = useState(false);

  const allDays = useMemo(() => Array.from({ length: 7 }, (_, i) => addDaysISO(weekStart, i)), [weekStart]);
  const days = useMemo(() => (onlyToday ? allDays.filter(d => d === todayISO()) : allDays), [allDays, onlyToday]);

  const [meds, setMeds] = useState<Med[]>([]);
  const [stocks, setStocks] = useState<StocksMap>({});
  const [intakes, setIntakes] = useState<Record<string, boolean>>({}); // chiave: day|time|med

  // --- Editor farmaco (popup) ---
  const [editing, setEditing] = useState<null | {
    id: string; name: string; dosage: string | null; per_dose: number; times: TimeSlot[];
  }>(null);

  async function saveMed() {
    if (!editing) return;
    await sb!.from("meds").update({
      name: editing.name,
      dosage: editing.dosage,
      per_dose: editing.per_dose,
      times: editing.times
    }).eq("id", editing.id);
    setEditing(null);
    await loadMeds();
  }

  // --- Aggiungi nuovo farmaco ---
  const [adding, setAdding] = useState(false);
  const [newMed, setNewMed] = useState<{
    name: string; dosage: string; per_dose: number; threshold: number;
    times: TimeSlot[]; initBox: number; initDisp: number;
  }>({ name: "", dosage: "", per_dose: 1, threshold: 10, times: [], initBox: 0, initDisp: 0 });

  async function addMed() {
    if (!newMed.name || newMed.times.length === 0) {
      alert("Inserisci almeno il nome e una fascia oraria.");
      return;
    }
    const { data: created, error } = await sb!.from("meds")
      .insert({
        family_id: profile.family_id!, name: newMed.name,
        dosage: newMed.dosage || null,
        per_dose: newMed.per_dose,
        times: newMed.times,
        threshold: newMed.threshold,
        archived: false
      })
      .select("id")
      .single();
    if (error) { alert(error.message); return; }
    const medId = (created as any).id as string;

    const stockRows = [
      { med_id: medId, location: "Box", qty: newMed.initBox || 0 },
      { med_id: medId, location: "Dispensa", qty: newMed.initDisp || 0 },
    ];
    await sb!.from("stocks").insert(stockRows);

    setAdding(false);
    setNewMed({ name: "", dosage: "", per_dose: 1, threshold: 10, times: [], initBox: 0, initDisp: 0 });
    await loadMeds();
  }

  // --- Elimina/Archivia farmaco ---
  const [deleting, setDeleting] = useState<null | Med>(null);
  const [deleteKeepHistory, setDeleteKeepHistory] = useState<"archive" | "hard">("archive");

  async function archiveMed(m: Med) {
    await sb!.from("meds").update({ archived: true }).eq("id", m.id);
    await sb!.from("stocks").delete().eq("med_id", m.id);
    await loadMeds();
  }

  async function hardDeleteMed(m: Med) {
    await sb!.from("intake_logs").delete().eq("med_id", m.id).eq("family_id", profile.family_id);
    await sb!.from("stocks").delete().eq("med_id", m.id);
    await sb!.from("meds").delete().eq("id", m.id);
    await loadMeds();
  }

  // se non c'è famiglia → creala al volo (admin)
  useEffect(() => {
    (async () => {
      if (!profile.family_id) {
        const name = prompt("Nome famiglia (es. Famiglia Mamma)", "Famiglia Mamma");
        if (!name) return;
        const { data: fam, error } = await sb!.from("families").insert({ name }).select("id").single();
        if (!error) await sb!.from("profiles").update({ family_id: fam!.id, role: "admin" }).eq("id", profile.id);
        location.reload();
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // carica meds + stocks (NO seed)
  const loadMeds = async () => {
    if (!profile.family_id) return;
    const { data: medsNow } = await sb!.from("meds")
      .select("id,family_id,name,dosage,per_dose,times,threshold,archived")
      .eq("family_id", profile.family_id)
      .eq("archived", false)
      .order("name");

    setMeds((medsNow as Med[]) || []);

    if ((medsNow || []).length > 0) {
      const ids = (medsNow as Med[]).map(m => m.id);
      const { data: st } = await sb!.from("stocks").select("med_id,location,qty").in("med_id", ids);
      const map: StocksMap = {};
      (st || []).forEach((r: any) => {
        map[r.med_id] ||= { box: 0, dispensa: 0 };
        if (r.location === "Box") map[r.med_id].box = r.qty || 0;
        if (r.location === "Dispensa") map[r.med_id].dispensa = r.qty || 0;
      });
      setStocks(map);
    } else {
      setStocks({});
    }
  };

  const loadWeek = async () => {
    if (!profile.family_id) return;
    const from = onlyToday ? todayISO() : weekStart;
    const to = onlyToday ? todayISO() : addDaysISO(weekStart, 6);
    const { data } = await sb!.from("intake_logs")
      .select("day,time_slot,med_id,taken")
      .eq("family_id", profile.family_id)
      .gte("day", from).lte("day", to);
    const map: Record<string, boolean> = {};
    (data || []).forEach((r: any) => { map[`${r.day}|${r.time_slot}|${r.med_id}`] = !!r.taken; });
    setIntakes(map);
  };

  useEffect(() => { loadMeds(); /* eslint-disable-next-line */ }, [profile.family_id]);
  useEffect(() => { loadWeek(); /* eslint-disable-next-line */ }, [profile.family_id, weekStart, onlyToday]);

  // toggle presa (log + scala Box)
// toggle presa (log + scala Box) — versione fix con delete su "uncheck"
// aggiunge anche il parametro opzionale "force" per l'uso in bulk

const toggleTaken = async (
  day: string,
  time: TimeSlot,
  m: Med,
  force?: boolean
) => {
  const k = `${day}|${time}|${m.id}`;
  const next = typeof force === "boolean" ? force : !intakes[k];

  // aggiorna UI locale
  setIntakes((s) => ({ ...s, [k]: next }));

  if (next) {
    // spunta → upsert con onConflict
    const { error } = await sb!
      .from("intake_logs")
      .upsert(
        { family_id: profile.family_id, day, time_slot: time, med_id: m.id, taken: true },
        { onConflict: "family_id,day,time_slot,med_id" }
      );
    if (error) console.error("upsert intake_logs", error);
  } else {
    // togli spunta → DELETE (così al refresh non torna spuntato)
    const { error } = await sb!
      .from("intake_logs")
      .delete()
      .eq("family_id", profile.family_id)
      .eq("day", day)
      .eq("time_slot", time)
      .eq("med_id", m.id);
    if (error) console.error("delete intake_logs", error);
  }

  // aggiorna Box
  const { data: box } = await sb!
    .from("stocks")
    .select("id,qty")
    .eq("med_id", m.id)
    .eq("location", "Box")
    .single();

  if (box) {
    const newQty = Math.max(0, (box.qty || 0) + (next ? -m.per_dose : m.per_dose));
    await sb!.from("stocks").update({ qty: newQty }).eq("id", box.id);
    setStocks((st) => ({ ...st, [m.id]: { ...(st[m.id] || { box: 0, dispensa: 0 }), box: newQty } }));
  }
};
/** Elenco (med,slot) pianificati per OGGI */
function plannedDosesForToday(): { med: Med; slot: TimeSlot }[] {
  const rows: { med: Med; slot: TimeSlot }[] = [];
  TIMES.forEach((time) => {
    meds.filter((m) => (m.times || []).includes(time)).forEach((m) => rows.push({ med: m, slot: time }));
  });
  return rows;
}

/** Spunta/annulla in blocco tutti i farmaci di oggi */
async function markAllToday(checked: boolean) {
  const day = todayISO();
  const jobs: Promise<any>[] = [];
  plannedDosesForToday().forEach(({ med, slot }) => {
    const k = `${day}|${slot}|${med.id}`;
    const cur = !!intakes[k];
    if (cur !== checked) {
      // riusa toggleTaken con "force" per uno stato preciso
      jobs.push(toggleTaken(day, slot, med, checked));
    }
  });
  await Promise.all(jobs);
  await loadWeek(); // riallinea eventuali sfalsamenti
}

  // movimenti incrementali
  const moveFromPantry = async (m: Med, qty: number) => {
    if (!qty || qty <= 0) return;
    const { data: box } = await sb!.from("stocks").select("id,qty").eq("med_id", m.id).eq("location", "Box").single();
    const { data: pan } = await sb!.from("stocks").select("id,qty").eq("med_id", m.id).eq("location", "Dispensa").single();
    if (box && pan) {
      const newBox = (box.qty || 0) + qty;
      const newPan = Math.max(0, (pan.qty || 0) - qty);
      await sb!.from("stocks").update({ qty: newBox }).eq("id", box.id);
      await sb!.from("stocks").update({ qty: newPan }).eq("id", pan.id);
      setStocks(st => ({ ...st, [m.id]: { box: newBox, dispensa: newPan } }));
    }
  };
  const addPantry = async (m: Med, qty: number) => {
    if (!qty || qty <= 0) return;
    const { data: pan } = await sb!.from("stocks").select("id,qty").eq("med_id", m.id).eq("location", "Dispensa").single();
    if (pan) {
      const newPan = (pan.qty || 0) + qty;
      await sb!.from("stocks").update({ qty: newPan }).eq("id", pan.id);
      setStocks(st => ({ ...st, [m.id]: { ...(st[m.id] || { box: 0, dispensa: 0 }), dispensa: newPan } }));
    }
  };

  // correzione manuale assoluta
  const setBoxQty = async (m: Med, qty: number) => {
    if (qty < 0 || Number.isNaN(qty)) return;
    const { data: box } = await sb!.from("stocks").select("id").eq("med_id", m.id).eq("location", "Box").single();
    if (box) {
      await sb!.from("stocks").update({ qty }).eq("id", box.id);
      setStocks(st => ({ ...st, [m.id]: { ...(st[m.id] || { box: 0, dispensa: 0 }), box: qty } }));
    }
  };
  const setPantryQty = async (m: Med, qty: number) => {
    if (qty < 0 || Number.isNaN(qty)) return;
    const { data: pan } = await sb!.from("stocks").select("id").eq("med_id", m.id).eq("location", "Dispensa").single();
    if (pan) {
      await sb!.from("stocks").update({ qty }).eq("id", pan.id);
      setStocks(st => ({ ...st, [m.id]: { ...(st[m.id] || { box: 0, dispensa: 0 }), dispensa: qty } }));
    }
  };

  // indicatori scorte
  const weeklyNeed = (m: Med) => m.per_dose * (m.times?.length || 0) * 7;
  const totalStock = (m: Med) => (stocks[m.id]?.box || 0) + (stocks[m.id]?.dispensa || 0);
  const statusText = (m: Med) =>
    totalStock(m) < m.threshold ? "Sotto soglia" :
    totalStock(m) < weeklyNeed(m) ? "Copertura < 1 settimana" : "OK";

  // -------- Export PDF settimana (stampa browser) --------
  function exportWeekPDF() {
    const title = onlyToday
      ? `Assunzioni del ${days[0] || todayISO()}`
      : `Assunzioni ${weekStart} → ${addDaysISO(weekStart, 6)}`;
    let htmlRows = "";
    days.forEach(day => {
      htmlRows += `<tr><td colspan="5" style="background:#f5f5f5;font-weight:600;padding:6px">${day}</td></tr>`;
      TIMES.forEach(time => {
        const medsAt = meds.filter(m => (m.times || []).includes(time));
        medsAt.forEach(m => {
          const checked = intakes[`${day}|${time}|${m.id}`] ? "✓" : "";
          htmlRows += `<tr>
            <td>${time}</td>
            <td>${m.name}${m.dosage ? " – " + m.dosage : ""}</td>
            <td style="text-align:center">${m.per_dose}</td>
            <td style="text-align:center">${checked}</td>
          </tr>`;
        });
      });
    });
    const html = `<!doctype html><html><head><meta charset="utf-8">
      <title>${title}</title>
      <style>
        body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:24px}
        h1{font-size:18px;margin:0 0 10px}
        table{width:100%;border-collapse:collapse}
        th,td{border:1px solid #ddd;padding:6px;font-size:12px}
        th{background:#fafafa;text-align:left}
      </style></head><body>
      <h1>${title}</h1>
      <table>
        <thead><tr><th>Orario</th><th>Farmaco</th><th>Dose</th><th>Preso</th></tr></thead>
        <tbody>${htmlRows}</tbody>
      </table>
      <script>window.onload=()=>{window.print();}</script>
    </body></html>`;
    const w = window.open("", "_blank");
    if (w) { w.document.write(html); w.document.close(); }
  }

  return (
    <div style={{ padding: "28px", fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif" }}>
      <Title />
      <div style={{ margin: "6px 0 18px 0" }}>Benvenuto, <b>{profile.email}</b></div>

      {/* ---- Menù vista + toggle oggi + export ---- */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        <label style={{ fontSize: 14, color: "#444" }}>Mostra:</label>
        <select value={view} onChange={(e) => setView(e.target.value as any)} style={styles.select}>
          <option value="planner">Dose presa (planner settimanale)</option>
          <option value="stocks">Scorte & Rifornimenti</option>
        </select>

        {view === "planner" && (
  <>
    <label style={{ display: "inline-flex", alignItems: "center", gap: 6, marginLeft: 8, fontSize: 14 }}>
      <input type="checkbox" checked={onlyToday} onChange={(e) => setOnlyToday(e.target.checked)} />
      Solo oggi
    </label>

    {onlyToday && (
      <>
        <button
          style={{ ...styles.btn, padding: "8px 12px" }}
          onClick={() => markAllToday(true)}
          title="Segna tutti i farmaci di oggi come presi"
        >
          Spunta tutti oggi
        </button>
        <button
          style={{ ...styles.btn, padding: "8px 12px", background: "#6c757d" }}
          onClick={() => markAllToday(false)}
          title="Annulla tutte le spunte di oggi"
        >
          Annulla tutti oggi
        </button>
      </>
    )}

    <button style={{ ...styles.btn, padding: "8px 12px" }} onClick={exportWeekPDF}>
      Esporta PDF
    </button>
  </>
)}


        {view === "stocks" && (
          <button style={{ ...styles.btn, padding: "8px 12px" }} onClick={() => setAdding(true)}>+ Aggiungi nuovo farmaco</button>
        )}
      </div>

      {/* -------- Dose presa (planner settimanale) -------- */}

      {view === "planner" && (
        <Section title="Dose presa (planner settimanale)">
          {!onlyToday && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <button style={styles.nav} onClick={() => setWeekStart(addDaysISO(weekStart, -7))}>←</button>
              <div><b>{weekStart}</b> → <b>{addDaysISO(weekStart, 6)}</b></div>
              <button style={styles.nav} onClick={() => setWeekStart(addDaysISO(weekStart, 7))}>→</button>
              <button style={{ ...styles.nav, marginLeft: 8 }} onClick={() => setWeekStart(startOfWeekISO())}>Oggi</button>
            </div>
          )}

          {meds.length === 0 ? (
            <EmptyHint onAdd={() => setAdding(true)} />
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={styles.table}>
                <thead>
                  <tr>
                    {!onlyToday && <th>Giorno</th>}
                    <th>Orario</th><th>Farmaco</th><th>Dose</th><th>Preso?</th>
                  </tr>
                </thead>
                <tbody>
                  {days.flatMap(day => {
                    const rows: React.ReactElement[] = [];
                    if (!onlyToday) {
                      rows.push(
                        <tr key={`${day}-header`}>
                          <td colSpan={5} style={{ background: "#fafafa", fontWeight: 600 }}>{day}</td>
                        </tr>
                      );
                    }
                    TIMES.forEach(time => {
                      const medsAt = meds.filter(m => (m.times || []).includes(time));
                      medsAt.forEach((m, idx) => {
                        const bg = TIME_COLORS[time];
                        rows.push(
                          <tr key={`${day}-${time}-${m.id}`} style={{ background: bg }}>
                            {!onlyToday && <td>{idx === 0 ? day : ""}</td>}
                            <td>{idx === 0 ? time : ""}</td>
                            <td>{m.name} {m.dosage ? <span style={{ color: "#666" }}>– {m.dosage}</span> : null}</td>
                            <td>{m.per_dose} pill.</td>
                            <td>
                              <input type="checkbox"
                                checked={!!intakes[`${day}|${time}|${m.id}`]}
                                onChange={() => toggleTaken(day, time, m)}
                              />
                            </td>
                          </tr>
                        );
                      });
                    });
                    return rows;
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      )}

      {/* -------- Scorte & Rifornimenti -------- */}
      {view === "stocks" && (
        <Section title="Scorte & Rifornimenti">
          {meds.length === 0 ? (
            <EmptyHint onAdd={() => setAdding(true)} />
          ) : (
            <div style={{ display: "grid", gap: 12 }}>
              {meds.map(m => {
                const tone = statusTone(statusText(m)); // green | amber | red
                const toneColor = tone === "green" ? "#2ecc71" : tone === "amber" ? "#f39c12" : "#e74c3c";
                return (
                  <div key={m.id} style={{ ...styles.card, borderColor: toneColor, boxShadow: "0 1px 0 rgba(0,0,0,.02)" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div style={{ fontWeight: 600 }}>
                        {m.name} {m.dosage ? <span style={{ color: "#666" }}>– {m.dosage}</span> : null}
                        <button
                          style={{ marginLeft: 8, fontSize: 12, padding: "6px 8px", borderRadius: 8, border: "1px solid #ddd", background: "#fff", cursor: "pointer" }}
                          title="Modifica farmaco"
                          onClick={() =>
                            setEditing({ id: m.id, name: m.name, dosage: m.dosage, per_dose: m.per_dose, times: m.times || [] })
                          }
                        >
                          ✏️ Modifica
                        </button>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <Badge tone={tone}>{statusText(m)}</Badge>
                        <button
                          title="Elimina o archivia (mantieni storico)"
                          onClick={() => { setDeleting(m); setDeleteKeepHistory("archive"); }}
                          onAuxClick={() => {
                            if (confirm("Eliminare definitivamente il farmaco? (Cancellerà anche lo storico di assunzione)")) {
                              hardDeleteMed(m);
                            }
                          }}
                          style={{ ...styles.btnSmall, background: "#b30021" }}
                        >
                          🗑️ Elimina/Archivia
                        </button>
                      </div>
                    </div>
                    <div style={{ fontSize: 12, color: "#666", marginTop: 4 }}>
                      Fabbisogno settimanale: {weeklyNeed(m)} pill. · Totale: {totalStock(m)} (Box {stocks[m.id]?.box || 0} + Dispensa {stocks[m.id]?.dispensa || 0})
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 10 }}>
                      {/* BOX */}
                      <div style={styles.subcard}>
                        <div style={styles.label}>Box</div>
                        <div style={styles.big}>{stocks[m.id]?.box || 0}</div>

                        {/* Movimento incrementale */}
                        <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                          <input id={`box-move-${m.id}`} type="number" min={1} placeholder="qty" style={styles.inputSmall} />
                          <button
                            style={styles.btnSmall}
                            onClick={() => {
                              const el = document.getElementById(`box-move-${m.id}`) as HTMLInputElement | null;
                              const qty = Number(el?.value || 0); moveFromPantry(m, qty); if (el) el.value = "";
                            }}
                          >
                            ⇧ dalla Dispensa
                          </button>
                        </div>

                        {/* Impostazione assoluta */}
                        <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                          <input id={`box-set-${m.id}`} type="number" min={0} placeholder={`imposta (${stocks[m.id]?.box ?? 0})`} style={styles.inputSmall} />
                          <button
                            style={{ ...styles.btnSmall, background: "#555" }}
                            onClick={() => {
                              const el = document.getElementById(`box-set-${m.id}`) as HTMLInputElement | null;
                              const qty = Number(el?.value ?? "");
                              if (!Number.isNaN(qty) && qty >= 0) setBoxQty(m, qty);
                              if (el) el.value = "";
                            }}
                          >
                            Salva
                          </button>
                        </div>
                      </div>

                      {/* DISPENSA */}
                      <div style={styles.subcard}>
                        <div style={styles.label}>Dispensa</div>
                        <div style={styles.big}>{stocks[m.id]?.dispensa || 0}</div>

                        {/* Movimento incrementale */}
                        <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                          <input id={`pan-add-${m.id}`} type="number" min={1} placeholder="qty" style={styles.inputSmall} />
                          <button
                            style={styles.btnSmall}
                            onClick={() => {
                              const el = document.getElementById(`pan-add-${m.id}`) as HTMLInputElement | null;
                              const qty = Number(el?.value || 0); addPantry(m, qty); if (el) el.value = "";
                            }}
                          >
                            + da Farmacia
                          </button>
                        </div>

                        {/* Impostazione assoluta */}
                        <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                          <input id={`pan-set-${m.id}`} type="number" min={0} placeholder={`imposta (${stocks[m.id]?.dispensa ?? 0})`} style={styles.inputSmall} />
                          <button
                            style={{ ...styles.btnSmall, background: "#555" }}
                            onClick={() => {
                              const el = document.getElementById(`pan-set-${m.id}`) as HTMLInputElement | null;
                              const qty = Number(el?.value ?? "");
                              if (!Number.isNaN(qty) && qty >= 0) setPantryQty(m, qty);
                              if (el) el.value = "";
                            }}
                          >
                            Salva
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Section>
      )}

      <div style={{ marginTop: 18 }}>
        <button onClick={onLogout} style={{ ...styles.btn, background: "#e74c3c" }}>Esci</button>
      </div>

      {/* ---- Popup Modifica farmaco ---- */}
      {editing && (
        <Modal onClose={() => setEditing(null)}>
          <h3 style={{ marginTop: 0 }}>Modifica farmaco</h3>
          <Field label="Nome">
            <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} style={styles.inputFull} />
          </Field>
          <Field label="Dosaggio (es. 5mg)">
            <input value={editing.dosage || ""} onChange={(e) => setEditing({ ...editing, dosage: e.target.value || null })} style={styles.inputFull} />
          </Field>
          <Field label="Pillole per dose">
            <input type="number" min={1} value={editing.per_dose}
              onChange={(e) => setEditing({ ...editing, per_dose: Number(e.target.value || 1) })} style={styles.inputFull} />
          </Field>
          <div style={{ margin: "8px 0 4px" }}>Fasce orarie</div>
          {TIMES.map((t) => (
            <label key={t} style={{ display: "inline-flex", gap: 6, marginRight: 12 }}>
              <input
                type="checkbox"
                checked={editing.times.includes(t)}
                onChange={(e) => {
                  const on = e.target.checked;
                  setEditing({
                    ...editing,
                    times: on ? [...editing.times, t] : editing.times.filter((x) => x !== t)
                  });
                }}
              />
              {t}
            </label>
          ))}
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button style={{ ...styles.btn, flex: 1, background: "#2ecc71" }} onClick={saveMed}>Salva</button>
            <button style={{ ...styles.btn, flex: 1, background: "#e74c3c" }} onClick={() => setEditing(null)}>Annulla</button>
          </div>
        </Modal>
      )}

      {/* ---- Popup Elimina/Archivia ---- */}
      {deleting && (
        <Modal onClose={() => setDeleting(null)}>
          <h3 style={{ marginTop: 0 }}>Rimuovi “{deleting.name}”</h3>
          <p style={{ marginTop: 0, color: "#555" }}>
            Come vuoi procedere?
          </p>

          <label style={{ display: "block", margin: "6px 0" }}>
            <input
              type="radio"
              name="delopt"
              checked={deleteKeepHistory === "archive"}
              onChange={() => setDeleteKeepHistory("archive")}
            />{" "}
            <b>Archivia</b> – il farmaco non sarà più visibile, <u>lo storico di assunzione viene mantenuto</u>. Le scorte vengono rimosse.
          </label>

          <label style={{ display: "block", margin: "6px 0" }}>
            <input
              type="radio"
              name="delopt"
              checked={deleteKeepHistory === "hard"}
              onChange={() => setDeleteKeepHistory("hard")}
            />{" "}
            <b>Elimina definitivamente</b> – cancella <u>scorte + storico assunzione</u> e il farmaco.
          </label>

          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button
              style={{ ...styles.btn, flex: 1, background: "#b30021" }}
              onClick={async () => {
                const m = deleting!;
                setDeleting(null);
                if (deleteKeepHistory === "archive") await archiveMed(m);
                else await hardDeleteMed(m);
              }}
            >
              Conferma
            </button>
            <button style={{ ...styles.btn, flex: 1, background: "#666" }} onClick={() => setDeleting(null)}>
              Annulla
            </button>
          </div>
        </Modal>
      )}

      {/* ---- Popup Aggiungi farmaco ---- */}
      {adding && (
        <Modal onClose={() => setAdding(false)}>
          <h3 style={{ marginTop: 0 }}>Aggiungi nuovo farmaco</h3>
          <Field label="Nome">
            <input value={newMed.name} onChange={(e) => setNewMed({ ...newMed, name: e.target.value })} style={styles.inputFull} />
          </Field>
          <Field label="Dosaggio (es. 5mg)">
            <input value={newMed.dosage} onChange={(e) => setNewMed({ ...newMed, dosage: e.target.value })} style={styles.inputFull} />
          </Field>
          <Field label="Pillole per dose">
            <input type="number" min={1} value={newMed.per_dose}
              onChange={(e) => setNewMed({ ...newMed, per_dose: Number(e.target.value || 1) })} style={styles.inputFull} />
          </Field>
          <Field label="Soglia minima (alert)">
            <input type="number" min={0} value={newMed.threshold}
              onChange={(e) => setNewMed({ ...newMed, threshold: Number(e.target.value || 0) })} style={styles.inputFull} />
          </Field>
          <div style={{ margin: "8px 0 4px" }}>Fasce orarie</div>
          {TIMES.map((t) => (
            <label key={t} style={{ display: "inline-flex", gap: 6, marginRight: 12 }}>
              <input
                type="checkbox"
                checked={newMed.times.includes(t)}
                onChange={(e) => {
                  const on = e.target.checked;
                  setNewMed({
                    ...newMed,
                    times: on ? [...newMed.times, t] : newMed.times.filter((x) => x !== t)
                  });
                }}
              />
              {t}
            </label>
          ))}

          <div style={{ marginTop: 12, fontWeight: 600 }}>Quantità iniziali</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Box (pillole)">
              <input type="number" min={0} value={newMed.initBox}
                onChange={(e) => setNewMed({ ...newMed, initBox: Number(e.target.value || 0) })}
                style={styles.inputFull} />
            </Field>
            <Field label="Dispensa (pillole)">
              <input type="number" min={0} value={newMed.initDisp}
                onChange={(e) => setNewMed({ ...newMed, initDisp: Number(e.target.value || 0) })}
                style={styles.inputFull} />
            </Field>
          </div>

          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button style={{ ...styles.btn, flex: 1 }} onClick={addMed}>Aggiungi</button>
            <button style={{ ...styles.btn, flex: 1, background: "#e74c3c" }} onClick={() => setAdding(false)}>Annulla</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ---------- UI helpers ----------
function Wrap({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: "28px", fontFamily: "system-ui,-apple-system,Segoe UI,Roboto,sans-serif" }}>{children}</div>;
}
function Title() {
  return (
    <h1 style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 36, marginTop: 0 }}>
      <span role="img" aria-label="pill">💊</span> <span>Farmaci Giannina</span>
    </h1>
  );
}
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 18 }}>
      <h2 style={{ fontSize: 18, margin: "0 0 8px 0" }}>{title}</h2>
      {children}
    </div>
  );
}
function Badge({ children, tone }: { children: React.ReactNode; tone: "green" | "amber" | "red" }) {
  const color = tone === "green" ? "#0a7b35" : tone === "amber" ? "#8a5b00" : "#8a001a";
  const bg = tone === "green" ? "#e8f6ee" : tone === "amber" ? "#fff5da" : "#ffe3ea";
  return <span style={{ fontSize: 12, padding: "3px 8px", borderRadius: 999, background: bg, color }}>{children}</span>;
}
function Small({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) {
  return <button onClick={onClick} style={{ fontSize: 12, color: "#666", background: "transparent", border: "none", cursor: "pointer" }}>{children}</button>;
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "block", marginTop: 8 }}>
      <div style={{ fontSize: 12, color: "#555", marginBottom: 4 }}>{label}</div>
      {children}
    </label>
  );
}
function Modal({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.35)", display: "grid", placeItems: "center", zIndex: 1000 }}>
      <div style={{ background: "#fff", padding: 16, borderRadius: 12, width: 420 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <div />
          <button onClick={onClose} style={{ background: "transparent", border: "none", fontSize: 20, lineHeight: 1, cursor: "pointer" }}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}
function EmptyHint({ onAdd }: { onAdd: () => void }) {
  return (
    <div style={{
      border: "1px dashed #ccc",
      borderRadius: 10,
      padding: 14,
      background: "#fcfcfc",
      color: "#444",
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12
    }}>
      <div>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>Nessun farmaco configurato</div>
        <div style={{ fontSize: 13, color: "#666" }}>
          Aggiungi almeno un farmaco per iniziare a usare planner e scorte.
        </div>
      </div>
      <button
        onClick={onAdd}
        style={{ padding: "8px 12px", background: "#0d6efd", color: "#fff", border: "none", borderRadius: 8, cursor: "pointer", whiteSpace: "nowrap" }}
      >
        + Aggiungi nuovo farmaco
      </button>
    </div>
  );
}

const styles = {
  input: { padding: "8px", width: 280, marginRight: 8, border: "1px solid #ccc", borderRadius: 8 },
  inputFull: { padding: "8px", width: "100%", border: "1px solid #ccc", borderRadius: 8 },
  inputSmall: { padding: "6px", width: 110, border: "1px solid #ccc", borderRadius: 8 } as React.CSSProperties,
  btn: { padding: "10px 14px", background: "#0d6efd", color: "#fff", border: "none", borderRadius: 8, cursor: "pointer" } as React.CSSProperties,
  btnSmall: { padding: "6px 8px", background: "#0d6efd", color: "#fff", border: "none", borderRadius: 8, cursor: "pointer", fontSize: 12 } as React.CSSProperties,
  nav: { padding: "4px 10px", borderRadius: 8, border: "1px solid #ddd", background: "#fff", cursor: "pointer" } as React.CSSProperties,
  table: { width: "100%", borderCollapse: "collapse" } as React.CSSProperties,
  card: { border: "2px solid #eee", borderRadius: 12, padding: 12, background: "#fff" } as React.CSSProperties,
  subcard: { border: "1px solid #f0f0f0", borderRadius: 10, padding: 10, background: "#fafafa" } as React.CSSProperties,
  label: { fontSize: 12, color: "#666" } as React.CSSProperties,
  big: { fontSize: 22, fontWeight: 700 } as React.CSSProperties,
  select: { padding: "6px 10px", borderRadius: 8, border: "1px solid #ccc" } as React.CSSProperties,
};

// utils
function statusTone(s: string): "green" | "amber" | "red" {
  if (s === "OK") return "green";
  if (s.startsWith("Copertura")) return "amber";
  return "red";
}
