// Citation chips, v1. Nothing on the kagent wire says "the answer cites this
// page" (there is no sources part in go/api/a2a), so the BFF derives the list
// from the URLs inside a web tool's result and speaks it as a CUSTOM artifact.
// The heading says what they are: pages a tool fetched during this run — not
// claims the answer was checked against.

import type { FC } from 'react';
import type { DataMessagePartProps } from '@assistant-ui/react';

// Byte-identical to SOURCES_CUSTOM_EVENT in packages/shared/src/agui.ts; the SPA
// spells the wire keys it matches on locally (see FleetAgUiAgent.ts).
export const SOURCES_CUSTOM_EVENT = 'fleet.dev/sources';

interface Source {
  url: string;
  title?: string;
}

const readSources = (data: unknown): Source[] => {
  const list = (typeof data === 'object' && data !== null ? (data as Record<string, unknown>).sources : undefined) as unknown;
  if (!Array.isArray(list)) return [];
  return list
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .filter((item) => typeof item.url === 'string')
    .map((item) => ({ url: item.url as string, ...(typeof item.title === 'string' ? { title: item.title } : {}) }));
};

const host = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

export const Sources: FC<DataMessagePartProps> = ({ data }) => {
  const sources = readSources(data);
  if (sources.length === 0) return null;
  return (
    <div className="aui-sources">
      <span className="aui-sources-label">Fetched by the agent</span>
      <ol className="aui-sources-list">
        {sources.map((source, index) => (
          <li key={source.url} className="aui-source">
            <a href={source.url} target="_blank" rel="noreferrer noopener" title={source.url}>
              <span className="aui-source-index">{index + 1}</span>
              {source.title ?? host(source.url)}
            </a>
          </li>
        ))}
      </ol>
    </div>
  );
};
