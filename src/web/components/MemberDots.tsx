import type { AgentConfig } from '../../shared/types';
import { PROVIDER_COLOR } from '../util';

/** One dot per member in its CLI's colour; large teams show the first few and "+N". */
export function MemberDots({
  agents,
  className,
  max = 4,
}: {
  agents: Pick<AgentConfig, 'name' | 'provider'>[];
  className: string;
  max?: number;
}) {
  const shown = agents.length > max ? agents.slice(0, max - 1) : agents;
  const more = agents.length - shown.length;
  return (
    <span className={className} title={agents.map((a) => `@${a.name}`).join(', ')}>
      {shown.map((a, i) => (
        <i key={i} style={{ background: PROVIDER_COLOR[a.provider] }} />
      ))}
      {more > 0 && <span className="dots-more">+{more}</span>}
    </span>
  );
}
