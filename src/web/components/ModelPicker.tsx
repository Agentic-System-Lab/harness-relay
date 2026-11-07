import { useState } from 'react';
import { effortsFor, type ProviderModels } from '../../shared/types';
import { useT } from '../i18n';

const CUSTOM = '__custom__';

interface Props {
  catalog?: ProviderModels;
  model: string;
  effort: string;
  onChange: (v: { model: string; effort: string }) => void;
  /** Text for the "inherit" option of each select, e.g. "預設（gpt-6.1-sol）". */
  inheritModelLabel: string;
  inheritEffortLabel: (model: string) => string;
}

/** Model + reasoning-effort selects driven by the models each CLI reports. */
export function ModelPicker({ catalog, model, effort, onChange, inheritModelLabel, inheritEffortLabel }: Props) {
  const t = useT();
  const models = catalog?.models ?? [];
  const known = !model || models.some((m) => m.id === model);
  const [customMode, setCustomMode] = useState(!known);
  const custom = customMode || !known;

  const efforts = catalog ? effortsFor(catalog, model || catalog.defaultModel) : [];
  // Keep an effort the list doesn't know (e.g. set before the catalog loaded) selectable.
  const effortOptions = effort && !efforts.includes(effort) ? [...efforts, effort] : efforts;

  const pickModel = (value: string) => {
    if (value === CUSTOM) {
      setCustomMode(true);
      return;
    }
    setCustomMode(false);
    const allowed = catalog ? effortsFor(catalog, value || catalog.defaultModel) : [];
    // Drop an effort the newly selected model does not support.
    onChange({ model: value, effort: effort && allowed.length && !allowed.includes(effort) ? '' : effort });
  };

  return (
    <div className="model-picker">
      <label className="field">
        <span>{t.models.model}</span>
        <select value={custom ? CUSTOM : model} onChange={(e) => pickModel(e.target.value)}>
          <option value="">{inheritModelLabel}</option>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {(m.label && m.label !== m.id ? `${m.label} (${m.id})` : m.id) + (m.latest ? ` · ${t.models.latest}` : '')}
            </option>
          ))}
          <option value={CUSTOM}>{t.models.custom}</option>
        </select>
        {custom && (
          <input
            value={model}
            placeholder={t.models.modelIdPlaceholder}
            autoFocus={customMode && !model}
            onChange={(e) => onChange({ model: e.target.value.trim(), effort })}
            spellCheck={false}
          />
        )}
      </label>
      <label className="field">
        <span>{t.models.effort}</span>
        <select value={effort} onChange={(e) => onChange({ model, effort: e.target.value })}>
          <option value="">{inheritEffortLabel(model)}</option>
          {effortOptions.map((e) => (
            <option key={e} value={e}>
              {t.effortLabel(e)}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
