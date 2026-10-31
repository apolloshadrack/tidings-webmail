import { Check, Monitor } from 'lucide-react';
import { useId } from 'react';
import { useSettings } from '../../state/settings';
import { ACCENTS, THEMES, type Theme } from '../../styles/themes';
import { Row, Section, Seg, ToggleRow } from './controls';

function ThemePreview({ theme }: { theme: Theme }) {
  const t = theme.tokens;
  return (
    <div className="preview" aria-hidden="true" style={{ background: t.surface }}>
      <div className="s" style={{ background: t.sunken, borderRight: `1px solid ${t.border}` }}>
        <i style={{ background: t.accent, width: '80%', height: 8, borderRadius: 4 }} />
        <i style={{ background: t.text3, opacity: 0.5, width: '70%' }} />
        <i style={{ background: t.text3, opacity: 0.35, width: '55%' }} />
        <i style={{ background: t.text3, opacity: 0.35, width: '62%' }} />
      </div>
      <div className="m">
        {[0, 1, 2].map((r) => (
          <div key={r} style={{ display: 'flex', alignItems: 'center', gap: 5, position: 'relative', paddingLeft: 5 }}>
            {r === 0 && <span style={{ position: 'absolute', left: 0, top: 1, bottom: 1, width: 2, borderRadius: 2, background: t.accent }} />}
            <span style={{ width: 5, height: 5, borderRadius: 5, background: r < 2 ? t.unread : 'transparent', flex: 'none' }} />
            <div style={{ flex: 1, display: 'grid', gap: 3 }}>
              <i style={{ background: t.text, width: r === 1 ? '60%' : '75%', opacity: r < 2 ? 0.9 : 0.55 }} />
              <i style={{ background: t.text2, width: '90%', opacity: 0.45, height: 4 }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ThemePicker({ themes, value, onPick, label }: { themes: Theme[]; value: string; onPick: (id: string) => void; label: string }) {
  return (
    <div className="theme-grid" role="group" aria-label={label}>
      {themes.map((th) => (
        <button key={th.id} type="button" className="theme-card" aria-pressed={th.id === value} onClick={() => onPick(th.id)} aria-label={`${th.name} theme`}>
          <ThemePreview theme={th} />
          <div className="name">
            {th.name}
            {th.id === value && <Check size={14} aria-hidden="true" style={{ color: 'var(--accent)' }} />}
          </div>
          <div className="desc">{th.description}</div>
        </button>
      ))}
    </div>
  );
}

export function AppearanceTab() {
  const s = useSettings((x) => x.s);
  const set = useSettings((x) => x.set);
  const customId = useId();
  const light = THEMES.filter((t) => !t.dark);
  const dark = THEMES.filter((t) => t.dark);
  const custom = s.accent && !ACCENTS.includes(s.accent) ? s.accent : null;

  return (
    <>
      <Section title="Theme" lead="Changes apply instantly. Every theme is checked for readable contrast.">
        <Row title="Theme mode" hint="Match system switches between your light and dark choice with your device.">
          <Seg
            label="Theme mode"
            value={s.themeMode}
            onChange={(v) => set({ themeMode: v })}
            options={[
              { value: 'single', label: 'Single theme' },
              { value: 'system', label: 'Match system' },
            ]}
          />
        </Row>
        {s.themeMode === 'single' ? (
          <ThemePicker themes={THEMES} value={s.theme} onPick={(id) => set({ theme: id })} label="Theme" />
        ) : (
          <>
            <h4 className="s-sub">
              <Monitor size={14} aria-hidden="true" /> Light appearance
            </h4>
            <ThemePicker themes={light} value={s.lightTheme} onPick={(id) => set({ lightTheme: id })} label="Light theme" />
            <h4 className="s-sub">
              <Monitor size={14} aria-hidden="true" /> Dark appearance
            </h4>
            <ThemePicker themes={dark} value={s.darkTheme} onPick={(id) => set({ darkTheme: id })} label="Dark theme" />
          </>
        )}
        <Row title="Accent colour" hint="Used for the focus rail, unread markers and primary buttons. Adjusted automatically if it would be hard to read.">
          <div className="swatches" role="group" aria-label="Accent colour">
            <button
              type="button"
              className="swatch s-default-swatch"
              aria-pressed={!s.accent}
              aria-label="Theme default accent"
              title="Theme default"
              onClick={() => set({ accent: null })}
            >
              {!s.accent && <Check size={14} aria-hidden="true" />}
            </button>
            {ACCENTS.map((c) => (
              <button
                key={c}
                type="button"
                className="swatch"
                style={{ background: c, color: c }}
                aria-pressed={s.accent === c}
                aria-label={`Accent ${c}`}
                title={c}
                onClick={() => set({ accent: c })}
              >
                {s.accent === c && <Check size={14} color="#fff" aria-hidden="true" />}
              </button>
            ))}
            <label className="s-custom-color" htmlFor={customId} title="Custom colour">
              <input id={customId} type="color" value={custom ?? '#4f46e5'} onChange={(e) => set({ accent: e.target.value })} aria-label="Custom accent colour" />
              <span>{custom ? custom : 'Custom'}</span>
            </label>
          </div>
        </Row>
      </Section>

      <Section title="Layout and density">
        <Row title="Reading pane" hint="Where an open conversation appears.">
          <Seg
            label="Reading pane"
            value={s.layout}
            onChange={(v) => set({ layout: v })}
            options={[
              { value: 'columns', label: 'Right' },
              { value: 'rows', label: 'Below' },
              { value: 'list', label: 'Off' },
            ]}
          />
        </Row>
        <Row title="Density" hint="How much room each message row gets.">
          <Seg
            label="Density"
            value={s.density}
            onChange={(v) => set({ density: v })}
            options={[
              { value: 'comfortable', label: 'Comfortable' },
              { value: 'cozy', label: 'Cozy' },
              { value: 'compact', label: 'Compact' },
            ]}
          />
        </Row>
        <ToggleRow title="Show avatars" checked={s.showAvatars} onChange={(v) => set({ showAvatars: v })} />
        <ToggleRow title="Show message previews" hint="A line of the message under the subject." checked={s.showSnippets} onChange={(v) => set({ showSnippets: v })} />
      </Section>

      <Section title="Text">
        <Row title="Text size">
          <Seg
            label="Text size"
            value={s.fontSize}
            onChange={(v) => set({ fontSize: v })}
            options={[
              { value: 13, label: 'Small' },
              { value: 14, label: 'Default' },
              { value: 15, label: 'Large' },
              { value: 16, label: 'Larger' },
            ]}
          />
        </Row>
        <Row title="Font" hint="Inter is bundled with Tidings; System uses your device’s interface font.">
          <Seg
            label="Font"
            value={s.font}
            onChange={(v) => set({ font: v })}
            options={[
              { value: 'inter', label: 'Inter' },
              { value: 'system', label: 'System' },
            ]}
          />
        </Row>
        <Row title="Reduce motion" hint="Turns off animations and transitions.">
          <Seg
            label="Reduce motion"
            value={s.reduceMotion}
            onChange={(v) => set({ reduceMotion: v })}
            options={[
              { value: 'system', label: 'Match system' },
              { value: 'on', label: 'On' },
              { value: 'off', label: 'Off' },
            ]}
          />
        </Row>
      </Section>
    </>
  );
}
