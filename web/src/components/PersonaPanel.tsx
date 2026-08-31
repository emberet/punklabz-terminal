import { useState } from 'react';
import { api } from '../lib/api';
import { Panel } from './Panel';

export interface Persona {
  intro: string;
  notes: string[];
  traits: { aggression: number; patience: number; riskTolerance: number };
  updatedAt: number;
}

export interface AppliedMod {
  field: string;
  base: number;
  applied: number;
}

const TRAIT_LABELS: [keyof Persona['traits'], string][] = [
  ['aggression', 'Aggression'],
  ['patience', 'Patience'],
  ['riskTolerance', 'Risk tolerance'],
];

const MOD_LABELS: Record<string, string> = {
  positionSizePct: 'Position size %',
  cooldownMinutes: 'Cooldown (min)',
  maxTradesPerDay: 'Max trades/day',
  stopLossPct: 'Stop loss %',
};

function TraitBar({ value }: { value: number }) {
  return (
    <div style={{ flex: 1, height: 6, background: 'var(--bg-raised)' }}>
      <div style={{ width: `${value * 100}%`, height: '100%', background: 'var(--acid)' }} />
    </div>
  );
}

export function PersonaPanel({
  botId,
  persona,
  personaMods,
  onChanged,
}: {
  botId: number;
  persona: Persona | null;
  personaMods: AppliedMod[] | null;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(!persona);
  const [intro, setIntro] = useState(persona?.intro ?? '');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const save = async () => {
    setBusy(true);
    setErr('');
    try {
      await api.post(`/api/bots/${botId}/persona`, { intro });
      setEditing(false);
      onChanged();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const train = async () => {
    if (!note.trim()) return;
    setBusy(true);
    setErr('');
    try {
      await api.post(`/api/bots/${botId}/persona/train`, { note: note.trim() });
      setNote('');
      onChanged();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      title="Personality"
      sub="who your agent is — it chats AND trades in character"
      noPad
      right={
        persona && !editing ? (
          <button onClick={() => { setIntro(persona.intro); setEditing(true); }}>Rewrite</button>
        ) : undefined
      }
    >
      <div className="panel-body">
        {editing ? (
          <>
            <textarea
              value={intro}
              onChange={(e) => setIntro(e.target.value)}
              rows={4}
              style={{ width: '100%', resize: 'vertical' }}
              placeholder={'Describe your agent. e.g. "You are VULTURE — a paranoid ex-pit-trader. You only strike when everyone else panics, size small, cut losers instantly, and speak in short cold sentences."'}
            />
            <div className="row" style={{ marginTop: 8, gap: 8 }}>
              <button className="primary" disabled={busy || intro.trim().length < 10} onClick={save}>
                {busy ? 'distilling…' : persona ? 'Save personality' : 'Give it a personality'}
              </button>
              {persona && <button onClick={() => setEditing(false)}>Cancel</button>}
              <span className="dim" style={{ fontSize: 11 }}>
                Claude distills this into bounded trading traits — it can tilt the bot, never break its risk limits.
              </span>
            </div>
          </>
        ) : persona ? (
          <>
            <div className="soft" style={{ whiteSpace: 'pre-wrap', marginBottom: 12 }}>{persona.intro}</div>

            {TRAIT_LABELS.map(([key, label]) => (
              <div key={key} className="row" style={{ gap: 12, marginBottom: 6 }}>
                <span className="dim" style={{ width: 110, fontSize: 11, textTransform: 'uppercase', letterSpacing: 1 }}>{label}</span>
                <TraitBar value={persona.traits[key]} />
                <span className="acid" style={{ fontFamily: 'var(--font)', fontSize: 11, width: 32 }}>
                  {(persona.traits[key] * 100).toFixed(0)}
                </span>
              </div>
            ))}

            {personaMods && (
              <div style={{ marginTop: 10 }}>
                <div className="dim" style={{ fontSize: 10, letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 4 }}>
                  Applied to its trading config
                </div>
                <div className="row" style={{ flexWrap: 'wrap', gap: 14, fontSize: 12 }}>
                  {personaMods.map((m) => (
                    <span key={m.field} className="soft">
                      {MOD_LABELS[m.field] ?? m.field}: <span className="dim">{m.base}</span> →{' '}
                      <span className={m.applied === m.base ? '' : 'acid'}>{m.applied}</span>
                    </span>
                  ))}
                </div>
              </div>
            )}

            {persona.notes.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <div className="dim" style={{ fontSize: 10, letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 4 }}>
                  Training notes
                </div>
                {persona.notes.map((n, i) => (
                  <div key={i} className="soft" style={{ fontSize: 12 }}>▸ {n}</div>
                ))}
              </div>
            )}
          </>
        ) : null}
        {err && <div className="red" style={{ marginTop: 8, fontSize: 12 }}>{err}</div>}
      </div>
      {persona && !editing && (
        <div className="chat-input">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && train()}
            placeholder='train it — e.g. "be more patient" or "never risk more than a scratch"'
            disabled={busy}
          />
          <button onClick={train} disabled={busy || !note.trim()}>{busy ? '…' : 'Teach'}</button>
        </div>
      )}
    </Panel>
  );
}
