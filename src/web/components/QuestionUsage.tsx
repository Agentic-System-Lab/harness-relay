import { useState } from 'react';
import { PROVIDER_LABEL, type ChatMessage, type ReportedUsage } from '../../shared/types';
import { useI18n } from '../i18n';
import { reportedSubtotal, usageRows, type UsageRow } from '../questionUsage';

export function QuestionUsage({ messages }: { messages: ChatMessage[] }) {
  const { t, lang } = useI18n();
  const labels = t.questionUsage;
  const [open, setOpen] = useState(false);
  const rows = open ? usageRows(messages) : [];
  const stage = (row: UsageRow) => {
    if (row.kind === 'member') return `@${row.name}${row.round ? ` · ${t.message.round(row.round)}` : ''}`;
    if (row.kind === 'modelCheck') return `${labels.modelCheck} · ${PROVIDER_LABEL[row.provider]}${row.model ? ` / ${row.model}` : ''}`;
    return labels[row.kind];
  };
  const number = (value: number | undefined, key: keyof ReportedUsage) => {
    if (value === undefined) return labels.unknown;
    return key === 'costUsd'
      ? value.toLocaleString(lang, { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol', maximumFractionDigits: 6 })
      : value.toLocaleString(lang);
  };
  const metrics = ['inputTokens', 'outputTokens', 'costUsd'] as const;
  return (
    <details className="question-usage" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>{labels.title}</summary>
      {open && (
        <div className="question-usage-body">
          <table aria-label={labels.title}>
            <thead>
              <tr>
                <th scope="col">{labels.stage}</th>
                {metrics.map((k) => (
                  <th scope="col" key={k}>
                    {labels[k]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i}>
                  <th scope="row">{stage(row)}</th>
                  {metrics.map((k) => (
                    <td key={k}>{number(row[k], k)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">{labels.subtotal}</th>
                {metrics.map((k) => (
                  <td key={k}>{number(reportedSubtotal(rows, k), k)}</td>
                ))}
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </details>
  );
}
